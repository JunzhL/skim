import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMockConflictAdapter } from "@/lib/conflicts";
import { setupDemoRepository } from "@/lib/demo-setup";
import {
  clearInstallPreviewStoreForTests,
  confirmInstall,
  createInstallPreview,
} from "@/lib/transactions";
import { listTransactionHistory } from "@/lib/transactions/history";
import { undoInstallTransaction } from "@/lib/transactions/undo";
import {
  cleanupTempDirectories,
  commitAll,
  copyInto,
  initRepository,
  remoteUrl,
  tempDirectory,
} from "../helpers/git-fixtures";

afterEach(() => {
  clearInstallPreviewStoreForTests();
  cleanupTempDirectories();
});

function managedRepository(): string {
  return setupDemoRepository(join(tempDirectory("skim-history-managed-"), "demo"), {
    appRoot: process.cwd(),
  });
}

function npmSource() {
  const root = initRepository(tempDirectory("skim-history-source-"));
  copyInto(root, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
  const commit = commitAll(root, "add npm workflow");
  return {
    type: "git" as const,
    url: remoteUrl(root),
    commit,
    subdirectory: "skills/npm-workflow",
  };
}

function conflictAdapter() {
  return createMockConflictAdapter("openai", "mock-history", {
    commonScenario: "Adding a JavaScript dependency",
    confidence: 0.99,
    explanation: "The two skills require different package managers.",
    evidence: [
      { skillId: "npm-workflow", filePath: "SKILL.md", lineStart: 16, lineEnd: 16, quote: "use `npm install`" },
      { skillId: "package-manager-policy", filePath: "SKILL.md", lineStart: 16, lineEnd: 16, quote: "use `pnpm add`" },
    ],
  });
}

describe("dashboard transaction history", () => {
  it("resolves persisted self commits into real install and Undo commit SHAs", async () => {
    const managed = managedRepository();
    const preview = await createInstallPreview({
      repoPath: managed,
      source: npmSource(),
      createConflictAdapter: conflictAdapter,
      createPreviewId: () => "preview-history",
      createTransactionId: () => "tx-history",
      now: () => new Date("2026-09-20T00:15:00.000Z"),
    });
    const install = await confirmInstall({
      repoPath: managed,
      previewId: preview.previewId,
      resolution: "activate-incoming",
    });
    if (install.type !== "install") throw new Error("expected install");

    expect(listTransactionHistory(managed)).toEqual([install]);

    const undo = await undoInstallTransaction({
      repoPath: managed,
      transactionId: install.transactionId,
      createTransactionId: () => "undo-history",
      now: () => new Date("2026-09-20T00:16:00.000Z"),
    });
    if (undo.type !== "committed") throw new Error("expected committed Undo");

    const history = listTransactionHistory(managed);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(undo.transaction);
    expect(history[1]).toEqual(install);
  });
});
