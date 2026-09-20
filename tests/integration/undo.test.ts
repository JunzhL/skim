import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockConflictAdapter } from "@/lib/conflicts";
import { undoTransactionResponseSchema } from "@/lib/contracts";
import { setupDemoRepository } from "@/lib/demo-setup";
import { readRegistry } from "@/lib/registry";
import {
  clearInstallPreviewStoreForTests,
  confirmInstall,
  createInstallPreview,
  installTransactionStorage,
} from "@/lib/transactions";
import { undoInstallTransaction, undoTransactionStorage } from "@/lib/transactions/undo";
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
  return setupDemoRepository(join(tempDirectory("skim-undo-managed-"), "demo"), {
    appRoot: process.cwd(),
  });
}

function npmSource() {
  const root = initRepository(tempDirectory("skim-undo-source-"));
  copyInto(root, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
  const commit = commitAll(root, "add npm workflow");
  return {
    type: "git" as const,
    url: remoteUrl(root),
    commit,
    subdirectory: "skills/npm-workflow",
  };
}

function largeNpmSource() {
  const root = initRepository(tempDirectory("skim-undo-large-source-"));
  copyInto(root, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
  writeFile(
    root,
    "skills/npm-workflow/LARGE.md",
    `${"unchanged line\n".repeat(6_000)}expected tail\n`,
  );
  const commit = commitAll(root, "add large npm workflow");
  return {
    type: "git" as const,
    url: remoteUrl(root),
    commit,
    subdirectory: "skills/npm-workflow",
  };
}

function conflictAdapter() {
  return createMockConflictAdapter("openai", "mock-conflict-model", {
    commonScenario: "Adding a JavaScript dependency",
    confidence: 0.99,
    explanation: "The two skills require different package managers and lockfiles.",
    evidence: [
      { skillId: "npm-workflow", filePath: "SKILL.md", lineStart: 16, lineEnd: 16, quote: "use `npm install`" },
      { skillId: "package-manager-policy", filePath: "SKILL.md", lineStart: 16, lineEnd: 16, quote: "use `pnpm add`" },
    ],
  });
}

async function installNpm(
  managed: string,
  resolution: "keep-existing" | "activate-incoming",
  transactionId = "tx-undo-source",
) {
  const preview = await createInstallPreview({
    repoPath: managed,
    source: npmSource(),
    createConflictAdapter: conflictAdapter,
    createPreviewId: () => `preview-${transactionId}`,
    createTransactionId: () => transactionId,
    now: () => new Date("2026-09-19T23:50:00.000Z"),
  });
  const result = await confirmInstall({ repoPath: managed, previewId: preview.previewId, resolution });
  if (result.type !== "install") throw new Error("expected install transaction");
  return result;
}

function assignments(managed: string, agentId: string) {
  const agent = readRegistry(managed).agents.find((candidate) => candidate.id === agentId)!;
  return Object.fromEntries(agent.skills.map((assignment) => [assignment.skillId, assignment.enabled]));
}

describe("conflict-safe Undo", () => {
  it("undoes activate-incoming with a new recovery commit and restores the original assignments", async () => {
    const managed = managedRepository();
    const initialCommit = git(managed, "rev-parse", "HEAD");
    const install = await installNpm(managed, "activate-incoming");
    const installCommit = install.afterCommit;

    const result = await undoInstallTransaction({
      repoPath: managed,
      transactionId: install.transactionId,
      createTransactionId: () => "undo-activate",
      now: () => new Date("2026-09-20T00:00:00.000Z"),
    });

    expect(result.type).toBe("committed");
    if (result.type !== "committed") throw new Error("expected committed Undo");
    expect(undoTransactionResponseSchema.parse(result)).toEqual(result);
    expect(result.transaction.originalTransactionId).toBe(install.transactionId);
    expect(result.transaction.beforeCommit).toBe(installCommit);
    expect(result.transaction.afterCommit).toBe(git(managed, "rev-parse", "HEAD"));
    expect(result.transaction.afterCommit).not.toBe(installCommit);
    expect(git(managed, "merge-base", "--is-ancestor", installCommit, result.transaction.afterCommit)).toBe("");
    expect(git(managed, "merge-base", "--is-ancestor", initialCommit, result.transaction.afterCommit)).toBe("");
    expect(assignments(managed, "builder")).toEqual({ "package-manager-policy": true });
    expect(assignments(managed, "reviewer")).toEqual({ "package-manager-policy": true });
    expect(readRegistry(managed).skills.map((skill) => skill.id)).toEqual(["package-manager-policy"]);
    expect(existsSync(join(managed, "skills/npm-workflow"))).toBe(false);

    const persisted = JSON.parse(
      readFileSync(join(managed, undoTransactionStorage.directory, "undo-activate.json"), "utf8"),
    );
    expect(persisted.afterCommit).toBe(undoTransactionStorage.selfCommitValue);
    expect(persisted.originalTransactionId).toBe(install.transactionId);
    expect(existsSync(join(managed, installTransactionStorage.directory, `${install.transactionId}.json`))).toBe(true);
    expect(workingTreeStatus(managed)).toBe("");
  });

  it("undoes keep-existing by removing the disabled incoming skill without changing the active policy", async () => {
    const managed = managedRepository();
    const install = await installNpm(managed, "keep-existing", "tx-keep");
    const result = await undoInstallTransaction({
      repoPath: managed,
      transactionId: install.transactionId,
      createTransactionId: () => "undo-keep",
    });
    expect(result.type).toBe("committed");
    expect(assignments(managed, "builder")).toEqual({ "package-manager-policy": true });
    expect(assignments(managed, "reviewer")).toEqual({ "package-manager-policy": true });
    expect(readRegistry(managed).skills.some((skill) => skill.id === "npm-workflow")).toBe(false);
  });

  it("preserves unrelated later commits and files", async () => {
    const managed = managedRepository();
    const install = await installNpm(managed, "activate-incoming", "tx-unrelated");
    writeFile(managed, "notes.txt", "keep this later commit\n");
    const unrelatedCommit = commitAll(managed, "add unrelated notes");

    const result = await undoInstallTransaction({
      repoPath: managed,
      transactionId: install.transactionId,
      createTransactionId: () => "undo-unrelated",
    });

    expect(result.type).toBe("committed");
    if (result.type !== "committed") throw new Error("expected committed Undo");
    expect(result.transaction.beforeCommit).toBe(unrelatedCommit);
    expect(readFileSync(join(managed, "notes.txt"), "utf8")).toBe("keep this later commit\n");
    expect(git(managed, "merge-base", "--is-ancestor", unrelatedCommit, result.transaction.afterCommit)).toBe("");
  });

  it("returns a three-way conflict without modifying Git when an affected file changed", async () => {
    const managed = managedRepository();
    const install = await installNpm(managed, "activate-incoming", "tx-conflict");
    writeFile(
      managed,
      "skills/npm-workflow/SKILL.md",
      readFileSync(join(managed, "skills/npm-workflow/SKILL.md"), "utf8") + "\nLater user edit.\n",
    );
    const editedCommit = commitAll(managed, "edit installed skill after transaction");

    const result = await undoInstallTransaction({
      repoPath: managed,
      transactionId: install.transactionId,
      createTransactionId: () => "undo-should-not-exist",
    });

    expect(result.type).toBe("conflict");
    if (result.type !== "conflict") throw new Error("expected Undo conflict");
    expect(undoTransactionResponseSchema.parse(result)).toEqual(result);
    expect(result.paths).toContain("skills/npm-workflow/SKILL.md");
    const file = result.files.find((candidate) => candidate.path === "skills/npm-workflow/SKILL.md")!;
    expect(file.before).toBeNull();
    expect(file.expectedAfter).toContain("use `npm install`");
    expect(file.current).toContain("Later user edit.");
    expect(file.threeWayDiff).toContain("(transaction before)");
    expect(file.threeWayDiff).toContain("(expected after)");
    expect(file.threeWayDiff).toContain("(current)");
    expect(git(managed, "rev-parse", "HEAD")).toBe(editedCommit);
    expect(existsSync(join(managed, undoTransactionStorage.directory, "undo-should-not-exist.json"))).toBe(false);
    expect(workingTreeStatus(managed)).toBe("");
  });

  it("treats an executable-bit change as an Undo conflict", async () => {
    const managed = managedRepository();
    const install = await installNpm(managed, "activate-incoming", "tx-mode-conflict");
    const skillPath = "skills/npm-workflow/SKILL.md";
    git(managed, "config", "core.fileMode", "true");
    chmodSync(join(managed, skillPath), 0o755);
    const editedCommit = commitAll(managed, "make installed skill executable");

    const result = await undoInstallTransaction({
      repoPath: managed,
      transactionId: install.transactionId,
      createTransactionId: () => "undo-mode-should-not-exist",
    });

    expect(result.type).toBe("conflict");
    if (result.type !== "conflict") throw new Error("expected Undo conflict");
    const file = result.files.find((candidate) => candidate.path === skillPath)!;
    expect(file.currentHash).toBe(file.expectedAfterHash);
    expect(file.expectedAfterMode).toBe("100644");
    expect(file.currentMode).toBe("100755");
    expect(file.threeWayDiff).toContain("content unchanged; Git tree metadata differs");
    expect(git(managed, "rev-parse", "HEAD")).toBe(editedCommit);
    expect(workingTreeStatus(managed)).toBe("");
  });

  it("shows changed content beyond the conflict display limit", async () => {
    const managed = managedRepository();
    const preview = await createInstallPreview({
      repoPath: managed,
      source: largeNpmSource(),
      createConflictAdapter: conflictAdapter,
      createPreviewId: () => "preview-large-conflict",
      createTransactionId: () => "tx-large-conflict",
    });
    const install = await confirmInstall({
      repoPath: managed,
      previewId: preview.previewId,
      resolution: "activate-incoming",
    });
    if (install.type !== "install") throw new Error("expected install transaction");

    const largePath = join(managed, "skills/npm-workflow/LARGE.md");
    writeFile(
      managed,
      "skills/npm-workflow/LARGE.md",
      readFileSync(largePath, "utf8").replace("expected tail", "current tail"),
    );
    const editedCommit = commitAll(managed, "edit large skill tail");
    const result = await undoInstallTransaction({
      repoPath: managed,
      transactionId: install.transactionId,
      createTransactionId: () => "undo-large-should-not-exist",
    });

    expect(result.type).toBe("conflict");
    if (result.type !== "conflict") throw new Error("expected Undo conflict");
    const file = result.files.find((candidate) => candidate.path === "skills/npm-workflow/LARGE.md")!;
    expect(file.expectedAfter).toContain("expected tail");
    expect(file.current).toContain("current tail");
    expect(file.threeWayDiff).toContain("-expected tail");
    expect(file.threeWayDiff).toContain("+current tail");
    expect(git(managed, "rev-parse", "HEAD")).toBe(editedCommit);
    expect(workingTreeStatus(managed)).toBe("");
  });

  it("rejects a repeated Undo without changing the recovery commit", async () => {
    const managed = managedRepository();
    const install = await installNpm(managed, "activate-incoming", "tx-repeat");
    const first = await undoInstallTransaction({
      repoPath: managed,
      transactionId: install.transactionId,
      createTransactionId: () => "undo-first",
    });
    expect(first.type).toBe("committed");
    const recoveryCommit = git(managed, "rev-parse", "HEAD");

    await expect(
      undoInstallTransaction({
        repoPath: managed,
        transactionId: install.transactionId,
        createTransactionId: () => "undo-second",
      }),
    ).rejects.toMatchObject({ code: "TRANSACTION_ALREADY_UNDONE" });

    expect(git(managed, "rev-parse", "HEAD")).toBe(recoveryCommit);
    expect(existsSync(join(managed, undoTransactionStorage.directory, "undo-second.json"))).toBe(false);
  });

  it("leaves the managed repository unchanged when recovery commit preparation fails", async () => {
    const managed = managedRepository();
    const install = await installNpm(managed, "activate-incoming", "tx-failure");
    const beforeUndo = git(managed, "rev-parse", "HEAD");

    await expect(
      undoInstallTransaction({
        repoPath: managed,
        transactionId: install.transactionId,
        createTransactionId: () => "undo-failure",
        hooks: { beforeCommit: () => { throw new Error("forced Undo commit failure"); } },
      }),
    ).rejects.toThrow(/forced Undo commit failure/);

    expect(git(managed, "rev-parse", "HEAD")).toBe(beforeUndo);
    expect(assignments(managed, "builder")).toEqual({
      "package-manager-policy": false,
      "npm-workflow": true,
    });
    expect(existsSync(join(managed, undoTransactionStorage.directory, "undo-failure.json"))).toBe(false);
    expect(workingTreeStatus(managed)).toBe("");
  });
});
