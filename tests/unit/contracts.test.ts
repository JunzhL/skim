import { describe, expect, it } from "vitest";
import {
  agentsFileSchema,
  agentRunSchema,
  conflictReportSchema,
  installPreviewSchema,
  installTransactionRequestSchema,
  installTransactionResponseSchema,
  skillRecordSchema,
  transactionRecordSchema,
  undoTransactionResponseSchema,
} from "@/lib/contracts";

const commit = "a".repeat(40);
const hash = "b".repeat(64);
const timestamp = "2026-09-19T18:00:00.000Z";
const skill = {
  id: "package-manager-policy",
  name: "Package Manager Policy",
  description: "Use pnpm consistently.",
  path: "skills/package-manager-policy",
  source: { type: "git" as const, url: "https://github.com/example/skills.git", commit, subdirectory: "skills/package-manager-policy", license: "MIT" },
  files: [{ path: "SKILL.md", hash }],
  scopes: { tasks: ["dependency-management"], fileGlobs: ["package.json"] },
  enabled: true,
};

const conflict = {
  skillAId: "package-manager-policy",
  skillBId: "npm-workflow",
  analysis: { provider: "openai" as const, model: "gpt-5.6-terra" },
  commonScenario: "Adding a JavaScript dependency",
  confidence: 0.95,
  explanation: "The package managers and lockfiles differ.",
  evidence: [
    { skillId: "package-manager-policy", filePath: "SKILL.md", lineStart: 3, lineEnd: 3, quote: "use pnpm add" },
    { skillId: "npm-workflow", filePath: "SKILL.md", lineStart: 3, lineEnd: 3, quote: "use npm install" },
  ],
};

describe("domain contracts", () => {
  it("accepts complete records", () => {
    expect(skillRecordSchema.parse(skill)).toEqual(skill);
    expect(agentsFileSchema.parse({ schemaVersion: 1, agents: [{ id: "builder", name: "Builder", skills: [{ skillId: skill.id, enabled: true, priority: 100 }] }] })).toBeTruthy();
    expect(conflictReportSchema.parse(conflict)).toBeTruthy();
    expect(installPreviewSchema.parse({ previewId: "preview-1", baseCommit: commit, incomingSkill: skill, unifiedDiff: "diff", conflicts: [conflict], allowedResolutions: ["keep-existing", "activate-incoming", "cancel"], createdAt: timestamp })).toBeTruthy();
    expect(transactionRecordSchema.parse({ transactionId: "tx-1", type: "install", resolution: "activate-incoming", beforeCommit: commit, afterCommit: "c".repeat(40), affectedPathHashes: [{ path: "agents.yaml", beforeHash: hash, afterHash: "d".repeat(64) }], createdAt: timestamp })).toBeTruthy();
    expect(transactionRecordSchema.parse({ transactionId: "tx-2", type: "undo", originalTransactionId: "tx-1", beforeCommit: "c".repeat(40), afterCommit: "d".repeat(40), affectedPathHashes: [{ path: "agents.yaml", beforeHash: hash, afterHash: null }], createdAt: timestamp })).toBeTruthy();
    expect(agentRunSchema.parse({ runId: "run-1", agentId: "builder", task: "add zod", configurationCommit: commit, interceptedExecutable: "pnpm", interceptedArguments: ["add", "zod"], expectedLockfile: "pnpm-lock.yaml", status: "completed", timestamp })).toBeTruthy();
  });

  it.each([
    ["bad id", { ...skill, id: "Bad Id" }],
    ["bad hash", { ...skill, files: [{ path: "SKILL.md", hash: "xyz" }] }],
    ["bad commit", { ...skill, source: { ...skill.source, commit: "ABC" } }],
    ["absolute path", { ...skill, path: "/skills/a" }],
    ["windows path", { ...skill, path: "skills\\a" }],
    ["non-normalized path", { ...skill, path: "skills/../a" }],
    ["unknown source", { ...skill, source: { type: "archive", url: "https://example.com/a.zip" } }],
  ])("rejects %s", (_name, value) => {
    expect(skillRecordSchema.safeParse(value).success).toBe(false);
  });

  it("rejects invalid confidence, timestamps, resolutions, and duplicate agents", () => {
    expect(conflictReportSchema.safeParse({ ...conflict, confidence: 1.1 }).success).toBe(false);
    expect(installPreviewSchema.safeParse({ previewId: "preview-1", baseCommit: commit, incomingSkill: skill, unifiedDiff: "", conflicts: [], allowedResolutions: ["overwrite"], createdAt: "yesterday" }).success).toBe(false);
    const duplicate = { id: "builder", name: "Builder", skills: [] };
    expect(agentsFileSchema.safeParse({ schemaVersion: 1, agents: [duplicate, duplicate] }).success).toBe(false);
  });

  it("rejects transaction fields that do not match the transaction type", () => {
    const base = { transactionId: "tx-1", beforeCommit: commit, afterCommit: "c".repeat(40), affectedPathHashes: [], createdAt: timestamp };
    const install = { ...base, type: "install" as const, resolution: "keep-existing" as const };
    const undo = { ...base, type: "undo" as const, originalTransactionId: "tx-0" };
    expect(transactionRecordSchema.safeParse({ ...base, type: "install", resolution: "cancel" }).success).toBe(false);
    expect(transactionRecordSchema.safeParse({ ...base, type: "install", resolution: "keep-existing", originalTransactionId: "tx-0" }).success).toBe(false);
    expect(transactionRecordSchema.safeParse({ ...base, type: "undo" }).success).toBe(false);
    expect(transactionRecordSchema.safeParse({ ...base, type: "undo", originalTransactionId: "tx-0", resolution: "keep-existing" }).success).toBe(false);
    expect(installTransactionRequestSchema.safeParse({ previewId: "preview-1", resolution: "cancel" }).success).toBe(false);
    expect(installTransactionRequestSchema.safeParse({ previewId: "preview-1", resolution: "activate-incoming" }).success).toBe(true);
    expect(installTransactionResponseSchema.safeParse(install).success).toBe(true);
    expect(installTransactionResponseSchema.safeParse(undo).success).toBe(false);
    expect(undoTransactionResponseSchema.safeParse({ type: "committed", transaction: undo }).success).toBe(true);
    expect(undoTransactionResponseSchema.safeParse({ type: "committed", transaction: install }).success).toBe(false);
  });
});
