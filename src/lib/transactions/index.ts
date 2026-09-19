import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  installPreviewSchema,
  installTransactionRecordSchema,
  type AgentConfig,
  type ConflictReport,
  type GitImportSource,
  type InstallPreview,
  type InstallResolution,
  type InstallTransactionRecord,
  type SkillRecord,
} from "../contracts";
import {
  analyzeConflict,
  directoryConflictSource,
  type ConflictModelAdapter,
} from "../conflicts";
import { SkimError } from "../errors";
import { git, gitBuffer, headCommit, repositoryRoot, tryGit } from "../git";
import {
  buildRegistryFromDirectory,
  materializeRegistry,
  REGISTRY_FILE,
  type RegistrySnapshot,
} from "../registry";
import { importPinnedSkill, type ImportedSkill } from "../skills/import";
import { conflictAnalysisRequests, validateSkillSet } from "../validation";

const TRANSACTIONS_DIRECTORY = ".skim/transactions";
// A Git commit cannot contain its own SHA in a tracked file without creating a
// cryptographic self-reference. Persist "self" and resolve it to the containing
// commit when reading transaction history.
const SELF_COMMIT = "self";
const DEFAULT_ASSIGNMENT_PRIORITY = 100;

type RequiredPreview = InstallPreview & {
  transactionId: string;
  resolutionDiffs: {
    "keep-existing": string;
    "activate-incoming": string;
  };
};

type StoredPreview = {
  repoPath: string;
  source: GitImportSource;
  preview: RequiredPreview;
  incomingFingerprint: string;
  conflictingSkillIds: string[];
};

type PreviewRuntime = typeof globalThis & {
  __skimInstallPreviewStore?: Map<string, StoredPreview>;
};

const previewRuntime = globalThis as PreviewRuntime;
const previewStore = (previewRuntime.__skimInstallPreviewStore ??= new Map<string, StoredPreview>());

export type CreateInstallPreviewOptions = {
  repoPath: string;
  source: GitImportSource;
  createConflictAdapter: () => ConflictModelAdapter;
  now?: () => Date;
  createPreviewId?: () => string;
  createTransactionId?: () => string;
};

export type ConfirmInstallOptions = {
  repoPath: string;
  previewId: string;
  resolution: InstallResolution | "cancel";
  hooks?: {
    beforeCommit?: (worktree: string) => void | Promise<void>;
  };
};

export type CancelledInstall = {
  type: "cancelled";
  previewId: string;
  transactionId: string;
};

export type ConfirmInstallResult = InstallTransactionRecord | CancelledInstall;

type PreparedIncoming = {
  imported: ImportedSkill;
  incoming: SkillRecord;
  snapshot: RegistrySnapshot;
};

type PersistedInstallTransaction = {
  schemaVersion: 1;
  transactionId: string;
  type: "install";
  resolution: InstallResolution;
  beforeCommit: string;
  afterCommit: typeof SELF_COMMIT;
  affectedPathHashes: InstallTransactionRecord["affectedPathHashes"];
  createdAt: string;
};

function createId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertManagedRepositoryClean(repoPath: string): void {
  const status = git(repoPath, ["status", "--porcelain"]);
  if (status !== "") {
    throw new SkimError(
      "MANAGED_REPOSITORY_DIRTY",
      "Managed repository has uncommitted changes; create or confirm a preview only from a clean checkout",
      { status: status.split("\n").filter(Boolean) },
    );
  }
}

async function withDetachedWorktree<T>(
  repoPath: string,
  commit: string,
  operation: (worktree: string) => Promise<T>,
): Promise<T> {
  const parent = mkdtempSync(join(tmpdir(), "skim-transaction-"));
  const worktree = join(parent, "worktree");

  try {
    git(repoPath, ["worktree", "add", "--detach", worktree, commit]);
    return await operation(worktree);
  } finally {
    tryGit(repoPath, ["worktree", "remove", "--force", worktree]);
    tryGit(repoPath, ["worktree", "prune"]);
    rmSync(parent, { recursive: true, force: true });
  }
}

function sourceForImport(source: GitImportSource) {
  return {
    url: source.url,
    commit: source.commit,
    subdirectory: source.subdirectory,
  };
}

function validationFailure(errors: ReturnType<typeof validateSkillSet>["errors"]): never {
  throw new SkimError(
    "VALIDATION_FAILED",
    "Skill set has blocking structural validation errors",
    { errors },
  );
}

function prepareIncoming(worktree: string, source: GitImportSource): PreparedIncoming {
  const imported = importPinnedSkill({
    source: sourceForImport(source),
    destinationRoot: worktree,
  });
  const provenance = new Map([[imported.slug, imported.provenance]]);
  const snapshot = buildRegistryFromDirectory(worktree, { provenance });
  const incoming = snapshot.skills.find((skill) => skill.id === imported.slug);
  if (!incoming) {
    throw new SkimError(
      "PREVIEW_SOURCE_CHANGED",
      `Imported skill ${imported.slug} was not present in the prepared registry`,
      { skillId: imported.slug },
    );
  }
  return { imported, incoming, snapshot };
}

function incomingFingerprint(skill: SkillRecord): string {
  return JSON.stringify(skill);
}

function conflictingIdsForIncoming(
  incomingId: string,
  candidates: ReturnType<typeof validateSkillSet>["candidates"],
): string[] {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.skillAId === incomingId) ids.add(candidate.skillBId);
    if (candidate.skillBId === incomingId) ids.add(candidate.skillAId);
  }
  return [...ids].sort();
}

function modifyAgents(
  agents: AgentConfig[],
  incomingId: string,
  conflictingSkillIds: string[],
  resolution: InstallResolution,
): AgentConfig[] {
  const conflicts = new Set(conflictingSkillIds);
  return agents.map((agent) => {
    const isAffected =
      conflicts.size === 0 ||
      agent.skills.some((assignment) => conflicts.has(assignment.skillId)) ||
      agent.skills.some((assignment) => assignment.skillId === incomingId);
    if (!isAffected) return structuredClone(agent);

    const skills = agent.skills.map((assignment) =>
      resolution === "activate-incoming" && conflicts.has(assignment.skillId)
        ? { ...assignment, enabled: false }
        : { ...assignment },
    );
    const current = skills.find((assignment) => assignment.skillId === incomingId);
    if (current) {
      current.enabled = resolution === "activate-incoming";
    } else {
      skills.push({
        skillId: incomingId,
        enabled: resolution === "activate-incoming",
        priority: DEFAULT_ASSIGNMENT_PRIORITY,
      });
    }
    return { ...agent, skills };
  });
}

function writeAgents(worktree: string, agents: AgentConfig[]): void {
  writeFileSync(
    join(worktree, "agents.yaml"),
    stringifyYaml({ schemaVersion: 1, agents }, { lineWidth: 0 }),
  );
}

function stagedPaths(worktree: string): string[] {
  const raw = gitBuffer(worktree, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRT"]);
  return raw
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
}

function committedFileHash(worktree: string, commit: string, path: string): string | null {
  const result = tryGit(worktree, ["show", `${commit}:${path}`]);
  return result.ok ? sha256(result.stdout) : null;
}

function workingFileHash(worktree: string, path: string): string | null {
  const target = join(worktree, ...path.split("/"));
  return existsSync(target) ? sha256(readFileSync(target)) : null;
}

function affectedPathHashes(
  worktree: string,
  baseCommit: string,
  paths: string[],
): InstallTransactionRecord["affectedPathHashes"] {
  return paths.map((path) => ({
    path,
    beforeHash: committedFileHash(worktree, baseCommit, path),
    afterHash: workingFileHash(worktree, path),
  }));
}

function transactionPath(transactionId: string): string {
  return `${TRANSACTIONS_DIRECTORY}/${transactionId}.json`;
}

function writePersistedTransaction(
  worktree: string,
  transaction: PersistedInstallTransaction,
): string {
  const relativePath = transactionPath(transaction.transactionId);
  const target = join(worktree, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(transaction, null, 2)}\n`);
  return relativePath;
}

function validateFinalSnapshot(
  worktree: string,
  imported: ImportedSkill,
): RegistrySnapshot {
  const snapshot = materializeRegistry(
    worktree,
    new Map([[imported.slug, imported.provenance]]),
  );
  const validation = validateSkillSet({ skills: snapshot.skills, agents: snapshot.agents });
  if (validation.errors.length > 0) validationFailure(validation.errors);
  return snapshot;
}

function applyInstallResolution(
  worktree: string,
  prepared: PreparedIncoming,
  conflictingSkillIds: string[],
  resolution: InstallResolution,
): void {
  const agents = modifyAgents(
    prepared.snapshot.agents,
    prepared.incoming.id,
    conflictingSkillIds,
    resolution,
  );
  writeAgents(worktree, agents);
  validateFinalSnapshot(worktree, prepared.imported);
}

function persistedTransactionForCurrentChanges(
  worktree: string,
  baseCommit: string,
  transactionId: string,
  resolution: InstallResolution,
  createdAt: string,
): PersistedInstallTransaction {
  git(worktree, ["add", "-A"]);
  // Transaction metadata is deliberately excluded from its own affected-path
  // manifest; otherwise the record would need to contain the hash of itself.
  const businessPaths = stagedPaths(worktree).filter(
    (path) => !path.startsWith(`${TRANSACTIONS_DIRECTORY}/`),
  );
  return {
    schemaVersion: 1,
    transactionId,
    type: "install",
    resolution,
    beforeCommit: baseCommit,
    afterCommit: SELF_COMMIT,
    affectedPathHashes: affectedPathHashes(worktree, baseCommit, businessPaths),
    createdAt,
  };
}

function stagedDiff(worktree: string): string {
  git(worktree, ["add", "-A"]);
  return gitBuffer(worktree, [
    "diff",
    "--cached",
    "--binary",
    "--no-ext-diff",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ]).toString("utf8");
}

function restorePreviewMutation(worktree: string, baseCommit: string, transactionId: string): void {
  git(worktree, ["reset", "--mixed", baseCommit]);
  git(worktree, ["checkout", baseCommit, "--", "agents.yaml"]);

  const registryTracked = tryGit(worktree, ["cat-file", "-e", `${baseCommit}:${REGISTRY_FILE}`]).ok;
  if (registryTracked) {
    git(worktree, ["checkout", baseCommit, "--", REGISTRY_FILE]);
  } else {
    rmSync(join(worktree, ...REGISTRY_FILE.split("/")), { force: true });
  }
  rmSync(join(worktree, ...transactionPath(transactionId).split("/")), { force: true });
}

function buildResolutionDiff(
  worktree: string,
  baseCommit: string,
  prepared: PreparedIncoming,
  conflictingSkillIds: string[],
  resolution: InstallResolution,
  transactionId: string,
  createdAt: string,
): string {
  applyInstallResolution(worktree, prepared, conflictingSkillIds, resolution);
  const persisted = persistedTransactionForCurrentChanges(
    worktree,
    baseCommit,
    transactionId,
    resolution,
    createdAt,
  );
  writePersistedTransaction(worktree, persisted);
  const diff = stagedDiff(worktree);
  restorePreviewMutation(worktree, baseCommit, transactionId);
  return diff;
}

async function createConflictReports(
  worktree: string,
  prepared: PreparedIncoming,
  createConflictAdapter: () => ConflictModelAdapter,
): Promise<{ conflicts: ConflictReport[]; conflictingSkillIds: string[] }> {
  const installed = prepared.snapshot.skills.filter((skill) => skill.id !== prepared.incoming.id);
  const validation = validateSkillSet({
    skills: installed,
    agents: prepared.snapshot.agents,
    incoming: prepared.incoming,
  });
  if (validation.errors.length > 0) validationFailure(validation.errors);

  const requests = conflictAnalysisRequests(validation).filter(
    (request) => request.skillA.id === prepared.incoming.id || request.skillB.id === prepared.incoming.id,
  );
  const conflicts: ConflictReport[] = [];
  if (requests.length > 0) {
    const adapter = createConflictAdapter();
    const source = directoryConflictSource(worktree);
    for (const request of requests) {
      conflicts.push(await analyzeConflict(request, { adapter, source }));
    }
  }

  return {
    conflicts,
    conflictingSkillIds: conflictingIdsForIncoming(prepared.incoming.id, validation.candidates),
  };
}

export async function createInstallPreview(
  options: CreateInstallPreviewOptions,
): Promise<RequiredPreview> {
  const repoPath = repositoryRoot(options.repoPath);
  assertManagedRepositoryClean(repoPath);
  const baseCommit = headCommit(repoPath);
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const previewId = (options.createPreviewId ?? (() => createId("preview")))();
  const transactionId = (options.createTransactionId ?? (() => createId("tx")))();

  return withDetachedWorktree(repoPath, baseCommit, async (worktree) => {
    const prepared = prepareIncoming(worktree, options.source);
    const { conflicts, conflictingSkillIds } = await createConflictReports(
      worktree,
      prepared,
      options.createConflictAdapter,
    );

    const keepExistingDiff = buildResolutionDiff(
      worktree,
      baseCommit,
      prepared,
      conflictingSkillIds,
      "keep-existing",
      transactionId,
      createdAt,
    );
    const activateIncomingDiff = buildResolutionDiff(
      worktree,
      baseCommit,
      prepared,
      conflictingSkillIds,
      "activate-incoming",
      transactionId,
      createdAt,
    );

    const preview = installPreviewSchema.parse({
      previewId,
      transactionId,
      baseCommit,
      incomingSkill: prepared.incoming,
      unifiedDiff: activateIncomingDiff,
      resolutionDiffs: {
        "keep-existing": keepExistingDiff,
        "activate-incoming": activateIncomingDiff,
      },
      conflicts,
      allowedResolutions: ["keep-existing", "activate-incoming", "cancel"],
      createdAt,
    }) as RequiredPreview;

    previewStore.set(previewId, {
      repoPath,
      source: structuredClone(options.source),
      preview,
      incomingFingerprint: incomingFingerprint(prepared.incoming),
      conflictingSkillIds,
    });
    return structuredClone(preview);
  });
}

function requireStoredPreview(repoPath: string, previewId: string): StoredPreview {
  const stored = previewStore.get(previewId);
  if (!stored) {
    throw new SkimError("PREVIEW_NOT_FOUND", `Install preview ${previewId} was not found`, { previewId });
  }
  if (stored.repoPath !== repoPath) {
    throw new SkimError(
      "PREVIEW_REPOSITORY_MISMATCH",
      `Install preview ${previewId} belongs to a different managed repository`,
      { previewId },
    );
  }
  return stored;
}

function assertPreviewBase(repoPath: string, preview: StoredPreview): void {
  const current = headCommit(repoPath);
  if (current !== preview.preview.baseCommit) {
    throw new SkimError(
      "PREVIEW_STALE",
      `Managed repository HEAD moved after preview ${preview.preview.previewId}`,
      {
        previewId: preview.preview.previewId,
        baseCommit: preview.preview.baseCommit,
        currentCommit: current,
      },
    );
  }
}

function revalidateIncoming(prepared: PreparedIncoming, stored: StoredPreview): void {
  const validation = validateSkillSet({
    skills: prepared.snapshot.skills.filter((skill) => skill.id !== prepared.incoming.id),
    agents: prepared.snapshot.agents,
    incoming: prepared.incoming,
  });
  if (validation.errors.length > 0) validationFailure(validation.errors);

  if (incomingFingerprint(prepared.incoming) !== stored.incomingFingerprint) {
    throw new SkimError(
      "PREVIEW_SOURCE_CHANGED",
      `Pinned source no longer matches preview ${stored.preview.previewId}`,
      {
        previewId: stored.preview.previewId,
        skillId: prepared.incoming.id,
      },
    );
  }
}

export async function confirmInstall(
  options: ConfirmInstallOptions,
): Promise<ConfirmInstallResult> {
  const repoPath = repositoryRoot(options.repoPath);
  const stored = requireStoredPreview(repoPath, options.previewId);
  const resolution = options.resolution;

  if (resolution === "cancel") {
    previewStore.delete(options.previewId);
    return {
      type: "cancelled",
      previewId: options.previewId,
      transactionId: stored.preview.transactionId,
    };
  }

  assertManagedRepositoryClean(repoPath);
  assertPreviewBase(repoPath, stored);

  return withDetachedWorktree(repoPath, stored.preview.baseCommit, async (worktree) => {
    const prepared = prepareIncoming(worktree, stored.source);
    revalidateIncoming(prepared, stored);
    applyInstallResolution(
      worktree,
      prepared,
      stored.conflictingSkillIds,
      resolution,
    );

    const persisted = persistedTransactionForCurrentChanges(
      worktree,
      stored.preview.baseCommit,
      stored.preview.transactionId,
      resolution,
      stored.preview.createdAt,
    );
    writePersistedTransaction(worktree, persisted);
    git(worktree, ["add", "-A"]);

    await options.hooks?.beforeCommit?.(worktree);
    git(worktree, [
      "commit",
      "-m",
      `skim: install ${prepared.incoming.id} (${resolution})`,
    ]);
    const afterCommit = headCommit(worktree);
    const record = installTransactionRecordSchema.parse({
      transactionId: persisted.transactionId,
      type: "install",
      resolution: persisted.resolution,
      beforeCommit: persisted.beforeCommit,
      afterCommit,
      affectedPathHashes: persisted.affectedPathHashes,
      createdAt: persisted.createdAt,
    });

    assertManagedRepositoryClean(repoPath);
    assertPreviewBase(repoPath, stored);
    const merge = tryGit(repoPath, ["merge", "--ff-only", afterCommit]);
    if (!merge.ok) {
      if (headCommit(repoPath) !== stored.preview.baseCommit) {
        throw new SkimError(
          "PREVIEW_STALE",
          `Managed repository HEAD moved while confirming preview ${stored.preview.previewId}`,
          { previewId: stored.preview.previewId },
        );
      }
      throw new SkimError(
        "GIT_FAILED",
        `Could not fast-forward the managed repository to transaction ${stored.preview.transactionId}`,
        { stderr: merge.stderr, transactionId: stored.preview.transactionId },
      );
    }

    previewStore.delete(options.previewId);
    return record;
  });
}

export function clearInstallPreviewStoreForTests(): void {
  previewStore.clear();
}

export const installTransactionStorage = {
  directory: TRANSACTIONS_DIRECTORY,
  selfCommitValue: SELF_COMMIT,
} as const;
