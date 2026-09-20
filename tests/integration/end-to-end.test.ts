import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoAgent, createRecordingInterceptor, type RecordingInterceptor } from "@/lib/agents";
import { createConfiguredConflictAdapter, createMockConflictAdapter } from "@/lib/conflicts";
import type { ConflictModelProvider, RuntimeConfig } from "@/lib/runtime-config";
import { setupDemoRepository } from "@/lib/demo-setup";
import { isSkimError } from "@/lib/errors";
import { conflictReportSchema } from "@/lib/contracts";
import { readRegistry } from "@/lib/registry";
import { clearInstallPreviewStoreForTests, confirmInstall, createInstallPreview } from "@/lib/transactions";
import { undoInstallTransaction } from "@/lib/transactions/undo";
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

const interceptors: RecordingInterceptor[] = [];

afterEach(() => {
  clearInstallPreviewStoreForTests();
  cleanupTempDirectories();
  interceptors.splice(0);
});

function managedRepository(): string {
  return setupDemoRepository(join(tempDirectory("skim-e2e-managed-"), "demo"), { appRoot: process.cwd() });
}

function pinnedSource(fixture: string, slug: string, prefix: string) {
  const root = initRepository(tempDirectory(`skim-e2e-${prefix}-`));
  copyInto(root, `skills/${slug}`, fixture);
  return { type: "git" as const, url: remoteUrl(root), commit: commitAll(root, `publish ${slug}`), subdirectory: `skills/${slug}` };
}

const npmSource = () => pinnedSource("fixtures/authored-skills/npm-workflow", "npm-workflow", "npm");
const artSource = () => pinnedSource("fixtures/pinned-skills/algorithmic-art", "algorithmic-art", "art");

function malformedSource() {
  const root = initRepository(tempDirectory("skim-e2e-broken-"));
  writeFile(root, "skills/broken/SKILL.md", "---\nname: [unterminated\n---\n");
  return { type: "git" as const, url: remoteUrl(root), commit: commitAll(root, "publish broken skill"), subdirectory: "skills/broken" };
}

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    repoPath: "/unused",
    conflictModelProvider: "openai",
    openaiModel: "gpt-5.6-terra",
    deepseekModel: "deepseek-flash",
    ...overrides,
  };
}

function conflictAdapter(provider: ConflictModelProvider) {
  return createMockConflictAdapter(provider, `mock-${provider}`, {
    commonScenario: "Adding a JavaScript dependency",
    confidence: 0.98,
    explanation: "The two skills require different package managers and lockfiles.",
    evidence: [
      { skillId: "npm-workflow", filePath: "SKILL.md", lineStart: 16, lineEnd: 16, quote: "use `npm install`" },
      { skillId: "package-manager-policy", filePath: "SKILL.md", lineStart: 16, lineEnd: 16, quote: "use `pnpm add`" },
    ],
  });
}

function demoAgents(managed: string) {
  const interceptor = createRecordingInterceptor();
  interceptors.push(interceptor);
  const make = (agentId: string) =>
    createDemoAgent({ agentId, registryReader: async () => readRegistry(managed), commandInterceptor: interceptor });
  return { builder: make("builder"), reviewer: make("reviewer") };
}

function subjectsSince(managed: string, commit: string): string[] {
  return git(managed, "log", "--format=%s", `${commit}..HEAD`).split("\n").filter(Boolean).reverse();
}

/** Plays the documented runbook once and returns everything a reviewer can observe. */
async function runRunbook(provider: ConflictModelProvider) {
  const managed = managedRepository();
  const initialCommit = git(managed, "rev-parse", "HEAD");
  const { builder, reviewer } = demoAgents(managed);
  await builder.reload();
  await reviewer.reload();

  const trace = async () => [
    (await builder.run("add zod")).interceptedArguments.join(" "),
    (await reviewer.run("add zod")).interceptedArguments.join(" "),
  ];
  const reloadBoth = async () => {
    await builder.reload();
    await reviewer.reload();
  };

  const before = await trace();

  const preview = await createInstallPreview({
    repoPath: managed,
    source: npmSource(),
    createConflictAdapter: () => conflictAdapter(provider),
    createPreviewId: () => "preview-runbook",
    createTransactionId: () => "tx-runbook",
    now: () => new Date("2026-09-19T23:50:00.000Z"),
  });

  const install = await confirmInstall({ repoPath: managed, previewId: preview.previewId, resolution: "activate-incoming" });
  if (install.type !== "install") throw new Error("expected an install transaction");

  const afterInstallWithoutReload = await trace();
  await reloadBoth();
  const afterInstallReload = await trace();

  const undo = await undoInstallTransaction({
    repoPath: managed,
    transactionId: install.transactionId,
    createTransactionId: () => "tx-runbook-undo",
    now: () => new Date("2026-09-19T23:55:00.000Z"),
  });
  if (undo.type !== "committed") throw new Error("expected a recovery commit");

  const afterUndoWithoutReload = await trace();
  await reloadBoth();
  const afterUndoReload = await trace();

  return {
    conflict: {
      scenario: preview.conflicts[0].commonScenario,
      quotes: preview.conflicts[0].evidence.map((item) => `${item.skillId}:${item.quote}`).sort(),
    },
    commitSubjects: subjectsSince(managed, initialCommit),
    versions: {
      install: install.afterCommit === git(managed, "rev-parse", `${undo.transaction.afterCommit}~1`),
      undoFollowsInstall: undo.transaction.beforeCommit === install.afterCommit,
    },
    traces: { before, afterInstallWithoutReload, afterInstallReload, afterUndoWithoutReload, afterUndoReload },
    finalSkills: readRegistry(managed).skills.map((skill) => `${skill.id}:${skill.enabled}`),
    workingTree: workingTreeStatus(managed),
  };
}

describe("end-to-end runbook verification", () => {
  it.each<[ConflictModelProvider]>([["openai"], ["deepseek"]])(
    "completes the documented demo path with the %s adapter",
    async (provider) => {
      const result = await runRunbook(provider);

      expect(result.conflict).toEqual({
        scenario: "Adding a JavaScript dependency",
        quotes: ["npm-workflow:use `npm install`", "package-manager-policy:use `pnpm add`"],
      });
      expect(result.commitSubjects).toHaveLength(2);
      expect(result.commitSubjects[0]).toMatch(/npm-workflow/);
      expect(result.commitSubjects[1]).toMatch(/[Uu]ndo|[Rr]ecover|revert/);
      expect(result.versions).toEqual({ install: true, undoFollowsInstall: true });
      expect(result.traces).toEqual({
        before: ["add zod", "add zod"],
        afterInstallWithoutReload: ["add zod", "add zod"],
        afterInstallReload: ["install zod", "install zod"],
        afterUndoWithoutReload: ["install zod", "install zod"],
        afterUndoReload: ["add zod", "add zod"],
      });
      expect(result.finalSkills).toEqual(["package-manager-policy:true"]);
      expect(result.workingTree).toBe("");
    },
  );

  it("produces the same observable result for both providers and for a repeated run", async () => {
    const [openai, deepseek, repeated] = [await runRunbook("openai"), await runRunbook("deepseek"), await runRunbook("openai")];

    expect(deepseek).toEqual(openai);
    expect(repeated).toEqual(openai);
  });

  it("installs a no-conflict skill with no provider credentials configured", async () => {
    const managed = managedRepository();
    const initialCommit = git(managed, "rev-parse", "HEAD");
    const config = runtimeConfig();

    const preview = await createInstallPreview({
      repoPath: managed,
      source: artSource(),
      createConflictAdapter: () => createConfiguredConflictAdapter(config),
      createPreviewId: () => "preview-art",
      createTransactionId: () => "tx-art",
    });

    expect(preview.conflicts).toEqual([]);
    const install = await confirmInstall({ repoPath: managed, previewId: preview.previewId, resolution: "activate-incoming" });

    expect(install.type).toBe("install");
    expect(existsSync(join(managed, "skills/algorithmic-art/LICENSE.txt"))).toBe(true);
    expect(subjectsSince(managed, initialCommit)).toHaveLength(1);
    expect(readRegistry(managed).skills.map((skill) => skill.id)).toEqual(["algorithmic-art", "package-manager-policy"]);
    expect(workingTreeStatus(managed)).toBe("");
  });

  it.each<[ConflictModelProvider]>([["openai"], ["deepseek"]])(
    "reports missing %s credentials without touching the managed repository",
    async (provider) => {
      const managed = managedRepository();
      const head = git(managed, "rev-parse", "HEAD");
      const config = runtimeConfig({ conflictModelProvider: provider });

      let thrown: unknown;
      try {
        await createInstallPreview({
          repoPath: managed,
          source: npmSource(),
          createConflictAdapter: () => createConfiguredConflictAdapter(config),
          createPreviewId: () => `preview-${provider}`,
          createTransactionId: () => `tx-${provider}`,
        });
      } catch (error) {
        thrown = error;
      }

      expect(isSkimError(thrown, "MODEL_PROVIDER_CREDENTIALS_MISSING")).toBe(true);
      expect((thrown as Error).message).toContain(provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY");
      expect(git(managed, "rev-parse", "HEAD")).toBe(head);
      expect(workingTreeStatus(managed)).toBe("");
    },
  );

  it("invokes only the selected provider when both credentials are present", () => {
    const both = { openaiApiKey: "openai-key", deepseekApiKey: "deepseek-key" };
    expect(createConfiguredConflictAdapter(runtimeConfig({ ...both, conflictModelProvider: "openai" })).provider).toBe("openai");
    expect(createConfiguredConflictAdapter(runtimeConfig({ ...both, conflictModelProvider: "deepseek" })).provider).toBe("deepseek");
  });

  it("rejects malformed incoming skill metadata without touching the managed repository", async () => {
    const managed = managedRepository();
    const head = git(managed, "rev-parse", "HEAD");

    let thrown: unknown;
    try {
      await createInstallPreview({
        repoPath: managed,
        source: malformedSource(),
        createConflictAdapter: () => conflictAdapter("openai"),
        createPreviewId: () => "preview-broken",
        createTransactionId: () => "tx-broken",
      });
    } catch (error) {
      thrown = error;
    }

    expect(isSkimError(thrown, "INVALID_FRONTMATTER")).toBe(true);
    expect(git(managed, "rev-parse", "HEAD")).toBe(head);
    expect(workingTreeStatus(managed)).toBe("");
    expect(existsSync(join(managed, "skills/broken"))).toBe(false);
  });
});

/**
 * Optional live check. CI proves the normalized contract through mocked adapters; this runs the same
 * path against a real provider. Enable with, for example:
 *   SKIM_LIVE_PROVIDER=openai OPENAI_API_KEY=sk-... pnpm test
 */
describe("live provider smoke check", () => {
  const live = process.env.SKIM_LIVE_PROVIDER as ConflictModelProvider | undefined;
  const key = live === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;

  it.skipIf(!live || !key)(`analyses the authored conflict through the live ${live ?? "provider"} API`, async () => {
    const managed = managedRepository();
    const head = git(managed, "rev-parse", "HEAD");
    const config = runtimeConfig({
      conflictModelProvider: live,
      ...(live === "deepseek" ? { deepseekApiKey: key } : { openaiApiKey: key }),
      ...(process.env.OPENAI_MODEL ? { openaiModel: process.env.OPENAI_MODEL } : {}),
      ...(process.env.DEEPSEEK_MODEL ? { deepseekModel: process.env.DEEPSEEK_MODEL } : {}),
    });

    const preview = await createInstallPreview({
      repoPath: managed,
      source: npmSource(),
      createConflictAdapter: () => createConfiguredConflictAdapter(config),
      createPreviewId: () => "preview-live",
      createTransactionId: () => "tx-live",
    });

    expect(preview.conflicts).toHaveLength(1);
    expect(conflictReportSchema.safeParse(preview.conflicts[0]).success).toBe(true);
    expect(preview.conflicts[0].evidence.map((item) => item.skillId).sort()).toEqual([
      "npm-workflow",
      "package-manager-policy",
    ]);
    expect(git(managed, "rev-parse", "HEAD")).toBe(head);
    expect(workingTreeStatus(managed)).toBe("");
  }, 120_000);
});
