import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockConflictAdapter } from "@/lib/conflicts";
import { setupDemoRepository } from "@/lib/demo-setup";
import { readRegistry } from "@/lib/registry";
import {
  clearInstallPreviewStoreForTests,
  confirmInstall,
  createInstallPreview,
  installTransactionStorage,
} from "@/lib/transactions";
import {
  cleanupTempDirectories,
  commitAll,
  copyInto,
  git,
  initRepository,
  remoteUrl,
  tempDirectory,
  workingTreeStatus,
  writeFile,
} from "../helpers/git-fixtures";

afterEach(() => {
  clearInstallPreviewStoreForTests();
  cleanupTempDirectories();
});

function managedRepository(): string {
  return setupDemoRepository(join(tempDirectory("skim-managed-"), "demo"), { appRoot: process.cwd() });
}

function npmSource(): { root: string; source: { type: "git"; url: string; commit: string; subdirectory: string } } {
  const root = initRepository(tempDirectory("skim-npm-source-"));
  copyInto(root, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
  const commit = commitAll(root, "add npm workflow");
  return {
    root,
    source: {
      type: "git",
      url: remoteUrl(root),
      commit,
      subdirectory: "skills/npm-workflow",
    },
  };
}

function artSource(): { type: "git"; url: string; commit: string; subdirectory: string } {
  const root = initRepository(tempDirectory("skim-art-source-"));
  copyInto(root, "skills/algorithmic-art", "fixtures/pinned-skills/algorithmic-art");
  const commit = commitAll(root, "add algorithmic art");
  return {
    type: "git",
    url: remoteUrl(root),
    commit,
    subdirectory: "skills/algorithmic-art",
  };
}

function conflictAdapter() {
  return createMockConflictAdapter("openai", "mock-conflict-model", {
    commonScenario: "Adding a JavaScript dependency",
    confidence: 0.99,
    explanation: "The two skills require different package managers and lockfiles.",
    evidence: [
      {
        skillId: "npm-workflow",
        filePath: "SKILL.md",
        lineStart: 16,
        lineEnd: 16,
        quote: "use `npm install`",
      },
      {
        skillId: "package-manager-policy",
        filePath: "SKILL.md",
        lineStart: 16,
        lineEnd: 16,
        quote: "use `pnpm add`",
      },
    ],
  });
}

async function previewNpm(managed: string) {
  const { source } = npmSource();
  return createInstallPreview({
    repoPath: managed,
    source,
    createConflictAdapter: conflictAdapter,
    createPreviewId: () => "preview-npm",
    createTransactionId: () => "tx-npm",
    now: () => new Date("2026-09-19T23:30:00.000Z"),
  });
}

function assignments(managed: string, agentId: string) {
  const agent = readRegistry(managed).agents.find((candidate) => candidate.id === agentId)!;
  return Object.fromEntries(agent.skills.map((assignment) => [assignment.skillId, assignment.enabled]));
}

describe("atomic install previews and transactions", () => {
  it("creates a complete two-resolution preview without modifying the managed repository", async () => {
    const managed = managedRepository();
    const before = git(managed, "rev-parse", "HEAD");
    const preview = await previewNpm(managed);

    expect(git(managed, "rev-parse", "HEAD")).toBe(before);
    expect(workingTreeStatus(managed)).toBe("");
    expect(existsSync(join(managed, "skills/npm-workflow"))).toBe(false);
    expect(preview.transactionId).toBe("tx-npm");
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.allowedResolutions).toEqual(["keep-existing", "activate-incoming", "cancel"]);
    expect(preview.unifiedDiff).toBe(preview.resolutionDiffs?.["activate-incoming"]);
    expect(preview.resolutionDiffs?.["keep-existing"]).toContain("skills/npm-workflow/SKILL.md");
    expect(preview.resolutionDiffs?.["activate-incoming"]).toContain("agents.yaml");
    expect(preview.resolutionDiffs?.["activate-incoming"]).toContain(".skim/registry.json");
    expect(preview.resolutionDiffs?.["activate-incoming"]).toContain(".skim/transactions/tx-npm.json");
  });

  it("cancels a preview without creating an installation commit", async () => {
    const managed = managedRepository();
    const before = git(managed, "rev-parse", "HEAD");
    const preview = await previewNpm(managed);

    expect(await confirmInstall({ repoPath: managed, previewId: preview.previewId, resolution: "cancel" })).toEqual({
      type: "cancelled",
      previewId: "preview-npm",
      transactionId: "tx-npm",
    });
    expect(git(managed, "rev-parse", "HEAD")).toBe(before);
    expect(workingTreeStatus(managed)).toBe("");
    expect(existsSync(join(managed, "skills/npm-workflow"))).toBe(false);
  });

  it("commits keep-existing with the incoming skill disabled and existing policy active", async () => {
    const managed = managedRepository();
    const before = git(managed, "rev-parse", "HEAD");
    const preview = await previewNpm(managed);
    const record = await confirmInstall({
      repoPath: managed,
      previewId: preview.previewId,
      resolution: "keep-existing",
    });

    expect(record.type).toBe("install");
    if (record.type !== "install") throw new Error("expected install record");
    expect(record.resolution).toBe("keep-existing");
    expect(record.beforeCommit).toBe(before);
    expect(record.afterCommit).toBe(git(managed, "rev-parse", "HEAD"));
    expect(assignments(managed, "builder")).toEqual({
      "package-manager-policy": true,
      "npm-workflow": false,
    });
    expect(assignments(managed, "reviewer")).toEqual({
      "package-manager-policy": true,
      "npm-workflow": false,
    });
    expect(readRegistry(managed).skills.find((skill) => skill.id === "npm-workflow")?.enabled).toBe(false);

    const persisted = JSON.parse(
      readFileSync(join(managed, installTransactionStorage.directory, "tx-npm.json"), "utf8"),
    );
    expect(persisted.afterCommit).toBe(installTransactionStorage.selfCommitValue);
    expect(persisted.beforeCommit).toBe(before);
    expect(record.affectedPathHashes.map((entry) => entry.path)).toContain("agents.yaml");
    expect(record.affectedPathHashes.map((entry) => entry.path)).toContain(".skim/registry.json");
    expect(record.affectedPathHashes.map((entry) => entry.path)).toContain("skills/npm-workflow/SKILL.md");
    expect(record.affectedPathHashes.map((entry) => entry.path)).not.toContain(".skim/transactions/tx-npm.json");
    expect(workingTreeStatus(managed)).toBe("");
  });

  it("commits activate-incoming with npm enabled and the conflicting pnpm policy paused atomically", async () => {
    const managed = managedRepository();
    const preview = await previewNpm(managed);
    const record = await confirmInstall({
      repoPath: managed,
      previewId: preview.previewId,
      resolution: "activate-incoming",
    });

    expect(record.type).toBe("install");
    expect(assignments(managed, "builder")).toEqual({
      "package-manager-policy": false,
      "npm-workflow": true,
    });
    expect(assignments(managed, "reviewer")).toEqual({
      "package-manager-policy": false,
      "npm-workflow": true,
    });
    const registry = readRegistry(managed);
    expect(registry.skills.find((skill) => skill.id === "package-manager-policy")?.enabled).toBe(false);
    expect(registry.skills.find((skill) => skill.id === "npm-workflow")?.enabled).toBe(true);
    if (record.type !== "install") throw new Error("expected install record");
    const committedDiff = git(
      managed,
      "diff",
      "--binary",
      "--no-ext-diff",
      "--full-index",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${record.beforeCommit}..${record.afterCommit}`,
    );
    expect(committedDiff).toBe(preview.resolutionDiffs?.["activate-incoming"].trim());
    expect(workingTreeStatus(managed)).toBe("");
  });

  it("rejects confirmation when HEAD moved after the preview and leaves the new HEAD untouched", async () => {
    const managed = managedRepository();
    const preview = await previewNpm(managed);
    writeFile(managed, "notes.txt", "later edit\n");
    const laterCommit = commitAll(managed, "later unrelated commit");

    await expect(
      confirmInstall({ repoPath: managed, previewId: preview.previewId, resolution: "activate-incoming" }),
    ).rejects.toMatchObject({ code: "PREVIEW_STALE" });
    expect(git(managed, "rev-parse", "HEAD")).toBe(laterCommit);
    expect(readFileSync(join(managed, "notes.txt"), "utf8")).toBe("later edit\n");
    expect(existsSync(join(managed, "skills/npm-workflow"))).toBe(false);
    expect(workingTreeStatus(managed)).toBe("");
  });

  it("leaves no partial managed-repository state when preparation or commit fails", async () => {
    const managed = managedRepository();
    const before = git(managed, "rev-parse", "HEAD");
    const preview = await previewNpm(managed);

    await expect(
      confirmInstall({
        repoPath: managed,
        previewId: preview.previewId,
        resolution: "activate-incoming",
        hooks: {
          beforeCommit: () => {
            throw new Error("forced commit failure");
          },
        },
      }),
    ).rejects.toThrow(/forced commit failure/);

    expect(git(managed, "rev-parse", "HEAD")).toBe(before);
    expect(workingTreeStatus(managed)).toBe("");
    expect(existsSync(join(managed, "skills/npm-workflow"))).toBe(false);
    expect(existsSync(join(managed, ".skim/transactions/tx-npm.json"))).toBe(false);
  });

  it("re-fetches the pinned source at confirmation and fails without mutation if it is unavailable", async () => {
    const managed = managedRepository();
    const before = git(managed, "rev-parse", "HEAD");
    const { root, source } = npmSource();
    const preview = await createInstallPreview({
      repoPath: managed,
      source,
      createConflictAdapter: conflictAdapter,
      createPreviewId: () => "preview-source",
      createTransactionId: () => "tx-source",
    });
    rmSync(root, { recursive: true, force: true });

    await expect(
      confirmInstall({ repoPath: managed, previewId: preview.previewId, resolution: "activate-incoming" }),
    ).rejects.toBeTruthy();
    expect(git(managed, "rev-parse", "HEAD")).toBe(before);
    expect(workingTreeStatus(managed)).toBe("");
    expect(existsSync(join(managed, "skills/npm-workflow"))).toBe(false);
  });

  it("does not construct a model adapter for a no-conflict import", async () => {
    const managed = managedRepository();
    const createAdapter = vi.fn(() => {
      throw new Error("model must not be called");
    });

    const preview = await createInstallPreview({
      repoPath: managed,
      source: artSource(),
      createConflictAdapter: createAdapter,
      createPreviewId: () => "preview-art",
      createTransactionId: () => "tx-art",
    });

    expect(preview.conflicts).toEqual([]);
    expect(createAdapter).not.toHaveBeenCalled();
    expect(workingTreeStatus(managed)).toBe("");
  });
});
