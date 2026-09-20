import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  commitSchema,
  identifierSchema,
  installResolutionSchema,
  relativePosixPathSchema,
  sha256Schema,
  undoConflictSchema,
  undoTransactionRecordSchema,
  utcTimestampSchema,
  type InstallTransactionRecord,
  type UndoConflict,
  type UndoTransactionRecord,
} from "../contracts";
import { SkimError } from "../errors";
import { git, headCommit, repositoryRoot, tryGit } from "../git";

const TRANSACTIONS_DIRECTORY = ".skim/transactions";
const SELF_COMMIT = "self";
const MAX_CONFLICT_STATE_CHARS = 64 * 1024;
const MAX_CHANGED_HUNK_CHARS = 32 * 1024;
const MAX_DIFF_LINE_CHARS = 4 * 1024;
const DIFF_CONTEXT_LINES = 3;

const affectedPathHashSchema = z.object({
  path: relativePosixPathSchema,
  beforeHash: sha256Schema.nullable(),
  afterHash: sha256Schema.nullable(),
});

const persistedInstallTransactionSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: identifierSchema,
  type: z.literal("install"),
  resolution: installResolutionSchema,
  beforeCommit: commitSchema,
  afterCommit: z.literal(SELF_COMMIT),
  affectedPathHashes: z.array(affectedPathHashSchema),
  createdAt: utcTimestampSchema,
});

type PersistedInstallTransaction = z.infer<typeof persistedInstallTransactionSchema>;

type GitTreeEntry = {
  mode: string;
  type: string;
  objectId: string;
};

type PersistedUndoTransaction = {
  schemaVersion: 1;
  transactionId: string;
  type: "undo";
  originalTransactionId: string;
  beforeCommit: string;
  afterCommit: typeof SELF_COMMIT;
  affectedPathHashes: InstallTransactionRecord["affectedPathHashes"];
  createdAt: string;
};

export type UndoInstallOptions = {
  repoPath: string;
  transactionId: string;
  now?: () => Date;
  createTransactionId?: () => string;
  hooks?: {
    beforeCommit?: (worktree: string) => void | Promise<void>;
  };
};

export type UndoInstallResult =
  | { type: "committed"; transaction: UndoTransactionRecord }
  | UndoConflict;

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashOf(content: Buffer | null): string | null {
  return content === null ? null : sha256(content);
}

function transactionPath(transactionId: string): string {
  return `${TRANSACTIONS_DIRECTORY}/${transactionId}.json`;
}

function assertManagedRepositoryClean(repoPath: string): void {
  const status = git(repoPath, ["status", "--porcelain"]);
  if (status !== "") {
    throw new SkimError(
      "MANAGED_REPOSITORY_DIRTY",
      "Managed repository has uncommitted changes; Undo requires a clean checkout",
      { status: status.split("\n").filter(Boolean) },
    );
  }
}

async function withDetachedWorktree<T>(
  repoPath: string,
  commit: string,
  operation: (worktree: string) => Promise<T>,
): Promise<T> {
  const parent = mkdtempSync(join(tmpdir(), "skim-undo-"));
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

function fileAtCommit(repoPath: string, commit: string, path: string): Buffer | null {
  const result = tryGit(repoPath, ["show", `${commit}:${path}`]);
  return result.ok ? result.stdout : null;
}

function treeEntryAtCommit(repoPath: string, commit: string, path: string): GitTreeEntry | null {
  const output = git(repoPath, ["ls-tree", commit, "--", `:(literal)${path}`]);
  if (output === "") return null;
  const match = output.match(/^([0-7]{6}) ([^ ]+) ([0-9a-f]+)\t/);
  if (!match) {
    throw new SkimError(
      "TRANSACTION_INVALID",
      `Could not read the Git tree state for ${path}`,
      { commit, path, output },
    );
  }
  return { mode: match[1], type: match[2], objectId: match[3] };
}

function sameTreeEntry(left: GitTreeEntry | null, right: GitTreeEntry | null): boolean {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.type === right.type && left.objectId === right.objectId;
}

function fileInWorkingTree(root: string, path: string): Buffer | null {
  const target = join(root, ...path.split("/"));
  return existsSync(target) ? readFileSync(target) : null;
}

function findInstallCommit(repoPath: string, transactionId: string): string {
  const path = transactionPath(transactionId);
  const commits = git(repoPath, ["log", "--diff-filter=A", "--format=%H", "--", path])
    .split("\n")
    .filter(Boolean);

  if (commits.length === 0) {
    throw new SkimError(
      "TRANSACTION_NOT_FOUND",
      `Install transaction ${transactionId} was not found in the current history`,
      { transactionId },
    );
  }
  if (commits.length !== 1) {
    throw new SkimError(
      "TRANSACTION_INVALID",
      `Install transaction ${transactionId} was added more than once`,
      { transactionId, commits },
    );
  }
  return commits[0];
}

function readInstallTransaction(
  repoPath: string,
  transactionId: string,
  installCommit: string,
): PersistedInstallTransaction {
  const path = transactionPath(transactionId);
  const raw = fileAtCommit(repoPath, installCommit, path);
  if (raw === null) {
    throw new SkimError(
      "TRANSACTION_INVALID",
      `Transaction ${transactionId} is missing from its installation commit`,
      { transactionId, installCommit },
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new SkimError(
      "TRANSACTION_INVALID",
      `Transaction ${transactionId} is not valid JSON`,
      { transactionId, installCommit },
    );
  }

  const parsed = persistedInstallTransactionSchema.safeParse(document);
  if (!parsed.success || parsed.data.transactionId !== transactionId) {
    throw new SkimError(
      "TRANSACTION_INVALID",
      `Transaction ${transactionId} does not match the install transaction schema`,
      {
        transactionId,
        installCommit,
        issues: parsed.success
          ? [{ path: "transactionId", message: "Transaction id does not match the requested id" }]
          : parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
      },
    );
  }

  const parent = git(repoPath, ["rev-parse", `${installCommit}^`]);
  if (parent !== parsed.data.beforeCommit) {
    throw new SkimError(
      "TRANSACTION_INVALID",
      `Transaction ${transactionId} does not point to the parent of its installation commit`,
      {
        transactionId,
        installCommit,
        expectedParent: parsed.data.beforeCommit,
        actualParent: parent,
      },
    );
  }

  return parsed.data;
}

function assertNotAlreadyUndone(repoPath: string, transactionId: string): void {
  const needle = `"originalTransactionId": "${transactionId}"`;
  const commits = git(repoPath, [
    "log",
    "-S",
    needle,
    "--format=%H",
    "--",
    TRANSACTIONS_DIRECTORY,
  ])
    .split("\n")
    .filter(Boolean);

  if (commits.length > 0) {
    throw new SkimError(
      "TRANSACTION_ALREADY_UNDONE",
      `Install transaction ${transactionId} has already been undone`,
      { transactionId, undoCommits: commits },
    );
  }
}

function verifyRecordedStates(
  repoPath: string,
  installCommit: string,
  transaction: PersistedInstallTransaction,
): void {
  for (const entry of transaction.affectedPathHashes) {
    const recordedBefore = hashOf(fileAtCommit(repoPath, transaction.beforeCommit, entry.path));
    const recordedAfter = hashOf(fileAtCommit(repoPath, installCommit, entry.path));
    if (recordedBefore !== entry.beforeHash || recordedAfter !== entry.afterHash) {
      throw new SkimError(
        "TRANSACTION_INVALID",
        `Recorded hashes for ${entry.path} do not match Git history`,
        {
          transactionId: transaction.transactionId,
          path: entry.path,
          expectedBeforeHash: entry.beforeHash,
          actualBeforeHash: recordedBefore,
          expectedAfterHash: entry.afterHash,
          actualAfterHash: recordedAfter,
        },
      );
    }
  }
}

function textForDisplay(content: Buffer | null): string | null | undefined {
  if (content === null) return null;
  if (content.includes(0)) {
    return undefined;
  }
  return content.toString("utf8");
}

function firstDifference(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function stateForDisplay(content: Buffer | null, focusOffset = 0): string | null {
  const text = textForDisplay(content);
  if (text === null) return null;
  if (text === undefined) {
    return `<binary sha256=${sha256(content!)} bytes=${content!.byteLength}>`;
  }
  if (text.length <= MAX_CONFLICT_STATE_CHARS) return text;

  const halfWindow = Math.floor(MAX_CONFLICT_STATE_CHARS / 2);
  const start = Math.max(0, Math.min(text.length - MAX_CONFLICT_STATE_CHARS, focusOffset - halfWindow));
  const end = Math.min(text.length, start + MAX_CONFLICT_STATE_CHARS);
  return [
    ...(start > 0 ? ["[earlier content omitted]"] : []),
    text.slice(start, end),
    ...(end < text.length ? ["[later content omitted]"] : []),
  ].join("\n");
}

function boundedChangedLines(lines: string[], prefix: "-" | "+"): string[] {
  const rendered = lines.map((line) => {
    if (line.length <= MAX_DIFF_LINE_CHARS) return `${prefix}${line}`;
    const half = Math.floor(MAX_DIFF_LINE_CHARS / 2);
    return `${prefix}${line.slice(0, half)}[line content omitted]${line.slice(-half)}`;
  });
  const total = rendered.reduce((size, line) => size + line.length + 1, 0);
  if (total <= MAX_CHANGED_HUNK_CHARS / 2) return rendered;

  const budget = Math.floor(MAX_CHANGED_HUNK_CHARS / 4);
  const take = (values: string[], fromEnd: boolean): string[] => {
    const selected: string[] = [];
    let size = 0;
    const ordered = fromEnd ? [...values].reverse() : values;
    for (const value of ordered) {
      if (selected.length > 0 && size + value.length + 1 > budget) break;
      selected.push(value);
      size += value.length + 1;
    }
    return fromEnd ? selected.reverse() : selected;
  };

  return [
    ...take(rendered, false),
    `${prefix}[changed lines omitted]`,
    ...take(rendered, true),
  ];
}

function changedHunk(expectedAfter: Buffer | null, current: Buffer | null): string {
  const expectedText = textForDisplay(expectedAfter);
  const currentText = textForDisplay(current);
  if (expectedText === undefined || currentText === undefined) {
    return "@@ binary content; compare hashes above @@";
  }
  if (expectedText === currentText) return "@@ content unchanged; Git tree metadata differs @@";

  const expectedLines = (expectedText ?? "").split("\n");
  const currentLines = (currentText ?? "").split("\n");
  let prefix = 0;
  while (
    prefix < expectedLines.length &&
    prefix < currentLines.length &&
    expectedLines[prefix] === currentLines[prefix]
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < expectedLines.length - prefix &&
    suffix < currentLines.length - prefix &&
    expectedLines[expectedLines.length - 1 - suffix] === currentLines[currentLines.length - 1 - suffix]
  ) suffix += 1;

  const contextStart = Math.max(0, prefix - DIFF_CONTEXT_LINES);
  const expectedChangedEnd = expectedLines.length - suffix;
  const currentChangedEnd = currentLines.length - suffix;
  const contextEnd = Math.min(suffix, DIFF_CONTEXT_LINES);
  const beforeContext = expectedLines.slice(contextStart, prefix).map((line) => ` ${line}`);
  const afterContext = expectedLines
    .slice(expectedChangedEnd, expectedChangedEnd + contextEnd)
    .map((line) => ` ${line}`);

  return [
    `@@ -${prefix + 1},${expectedChangedEnd - prefix} +${prefix + 1},${currentChangedEnd - prefix} @@`,
    ...beforeContext,
    ...boundedChangedLines(expectedLines.slice(prefix, expectedChangedEnd), "-"),
    ...boundedChangedLines(currentLines.slice(prefix, currentChangedEnd), "+"),
    ...afterContext,
  ].join("\n");
}

function conflictFocusOffset(expectedAfter: Buffer | null, current: Buffer | null): number {
  const expectedText = textForDisplay(expectedAfter);
  const currentText = textForDisplay(current);
  return typeof expectedText === "string" && typeof currentText === "string"
    ? firstDifference(expectedText, currentText)
    : 0;
}

function threeWayDiff(
  path: string,
  before: Buffer | null,
  expectedAfter: Buffer | null,
  current: Buffer | null,
  beforeEntry: GitTreeEntry | null,
  expectedAfterEntry: GitTreeEntry | null,
  currentEntry: GitTreeEntry | null,
): string {
  const focusOffset = conflictFocusOffset(expectedAfter, current);
  const show = (content: Buffer | null) => stateForDisplay(content, focusOffset) ?? "<missing>";
  const mode = (entry: GitTreeEntry | null) => entry?.mode ?? "missing";
  return [
    `--- ${path} (transaction before) [mode ${mode(beforeEntry)}]`,
    show(before),
    `||||||| ${path} (expected after) [mode ${mode(expectedAfterEntry)}]`,
    show(expectedAfter),
    `======= ${path} (current) [mode ${mode(currentEntry)}]`,
    show(current),
    `>>>>>>> ${path}`,
    changedHunk(expectedAfter, current),
  ].join("\n");
}

function conflictForChangedPaths(
  repoPath: string,
  installCommit: string,
  currentCommit: string,
  transaction: PersistedInstallTransaction,
): UndoConflict | null {
  const files = transaction.affectedPathHashes.flatMap((entry) => {
    const current = fileAtCommit(repoPath, currentCommit, entry.path);
    const currentHash = hashOf(current);
    const before = fileAtCommit(repoPath, transaction.beforeCommit, entry.path);
    const expectedAfter = fileAtCommit(repoPath, installCommit, entry.path);
    const beforeEntry = treeEntryAtCommit(repoPath, transaction.beforeCommit, entry.path);
    const expectedAfterEntry = treeEntryAtCommit(repoPath, installCommit, entry.path);
    const currentEntry = treeEntryAtCommit(repoPath, currentCommit, entry.path);
    if (currentHash === entry.afterHash && sameTreeEntry(currentEntry, expectedAfterEntry)) return [];
    const focusOffset = conflictFocusOffset(expectedAfter, current);

    return [{
      path: entry.path,
      beforeHash: entry.beforeHash,
      expectedAfterHash: entry.afterHash,
      currentHash,
      beforeMode: beforeEntry?.mode ?? null,
      expectedAfterMode: expectedAfterEntry?.mode ?? null,
      currentMode: currentEntry?.mode ?? null,
      before: stateForDisplay(before, focusOffset),
      expectedAfter: stateForDisplay(expectedAfter, focusOffset),
      current: stateForDisplay(current, focusOffset),
      threeWayDiff: threeWayDiff(
        entry.path,
        before,
        expectedAfter,
        current,
        beforeEntry,
        expectedAfterEntry,
        currentEntry,
      ),
    }];
  });

  if (files.length === 0) return null;

  return undoConflictSchema.parse({
    type: "conflict",
    transactionId: transaction.transactionId,
    message:
      "Automatic Undo stopped because one or more files changed after the installation transaction.",
    paths: files.map((file) => file.path),
    files,
  });
}

function restoreBeforeState(
  worktree: string,
  repoPath: string,
  transaction: PersistedInstallTransaction,
): void {
  for (const entry of transaction.affectedPathHashes) {
    const target = join(worktree, ...entry.path.split("/"));
    if (entry.beforeHash === null) {
      rmSync(target, { recursive: true, force: true });
      continue;
    }

    const before = fileAtCommit(repoPath, transaction.beforeCommit, entry.path);
    if (before === null || sha256(before) !== entry.beforeHash) {
      throw new SkimError(
        "TRANSACTION_INVALID",
        `Could not restore the before-state for ${entry.path}`,
        { transactionId: transaction.transactionId, path: entry.path },
      );
    }
    git(worktree, ["checkout", transaction.beforeCommit, "--", `:(literal)${entry.path}`]);
  }
}

function undoAffectedHashes(
  worktree: string,
  beforeUndoCommit: string,
  paths: string[],
): InstallTransactionRecord["affectedPathHashes"] {
  return paths.map((path) => ({
    path,
    beforeHash: hashOf(fileAtCommit(worktree, beforeUndoCommit, path)),
    afterHash: hashOf(fileInWorkingTree(worktree, path)),
  }));
}

function writeUndoTransaction(
  worktree: string,
  transaction: PersistedUndoTransaction,
): void {
  const path = transactionPath(transaction.transactionId);
  const target = join(worktree, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(transaction, null, 2)}\n`);
}

export async function undoInstallTransaction(
  options: UndoInstallOptions,
): Promise<UndoInstallResult> {
  const repoPath = repositoryRoot(options.repoPath);
  const transactionId = identifierSchema.parse(options.transactionId);
  assertManagedRepositoryClean(repoPath);

  const beforeUndoCommit = headCommit(repoPath);
  const installCommit = findInstallCommit(repoPath, transactionId);
  const installTransaction = readInstallTransaction(repoPath, transactionId, installCommit);
  assertNotAlreadyUndone(repoPath, transactionId);
  verifyRecordedStates(repoPath, installCommit, installTransaction);

  const conflict = conflictForChangedPaths(
    repoPath,
    installCommit,
    beforeUndoCommit,
    installTransaction,
  );
  if (conflict !== null) return conflict;

  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const undoTransactionId = (options.createTransactionId ?? (() => `undo-${randomUUID()}`))();

  return withDetachedWorktree(repoPath, beforeUndoCommit, async (worktree) => {
    restoreBeforeState(worktree, repoPath, installTransaction);
    const affectedPathHashes = undoAffectedHashes(
      worktree,
      beforeUndoCommit,
      installTransaction.affectedPathHashes.map((entry) => entry.path),
    );

    const persisted: PersistedUndoTransaction = {
      schemaVersion: 1,
      transactionId: undoTransactionId,
      type: "undo",
      originalTransactionId: transactionId,
      beforeCommit: beforeUndoCommit,
      afterCommit: SELF_COMMIT,
      affectedPathHashes,
      createdAt,
    };
    writeUndoTransaction(worktree, persisted);
    git(worktree, ["add", "-A"]);

    await options.hooks?.beforeCommit?.(worktree);
    git(worktree, ["commit", "-m", `skim: undo ${transactionId}`]);
    const afterCommit = headCommit(worktree);

    const record = undoTransactionRecordSchema.parse({
      transactionId: undoTransactionId,
      type: "undo",
      originalTransactionId: transactionId,
      beforeCommit: beforeUndoCommit,
      afterCommit,
      affectedPathHashes,
      createdAt,
    });

    assertManagedRepositoryClean(repoPath);
    if (headCommit(repoPath) !== beforeUndoCommit) {
      throw new SkimError(
        "UNDO_STALE",
        `Managed repository HEAD moved while undoing transaction ${transactionId}`,
        {
          transactionId,
          baseCommit: beforeUndoCommit,
          currentCommit: headCommit(repoPath),
        },
      );
    }

    const merge = tryGit(repoPath, ["merge", "--ff-only", afterCommit]);
    if (!merge.ok) {
      if (headCommit(repoPath) !== beforeUndoCommit) {
        throw new SkimError(
          "UNDO_STALE",
          `Managed repository HEAD moved while undoing transaction ${transactionId}`,
          { transactionId },
        );
      }
      throw new SkimError(
        "GIT_FAILED",
        `Could not fast-forward the managed repository to Undo ${undoTransactionId}`,
        {
          transactionId,
          undoTransactionId,
          stderr: merge.stderr,
        },
      );
    }

    return { type: "committed", transaction: record };
  });
}

export const undoTransactionStorage = {
  directory: TRANSACTIONS_DIRECTORY,
  selfCommitValue: SELF_COMMIT,
} as const;
