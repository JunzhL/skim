import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { setupDemoRepository } from "../src/lib/demo-setup";

let root: string;
let repository: string;
let server: ChildProcess;

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error("Next.js server did not stop")),
      10_000,
    );

    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });

    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}

async function serverIsReachable(): Promise<boolean> {
  try {
    await fetch("http://127.0.0.1:3100", {
      signal: AbortSignal.timeout(250),
    });
    return true;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "skim-dashboard-e2e-"));
  repository = setupDemoRepository(join(root, "demo"), {
    appRoot: process.cwd(),
  });

  server = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/start-next.mjs",
      "dev",
      "--turbopack",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3100",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SKIM_REPO_PATH: repository,
      },
      stdio: "ignore",
    },
  );

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:3100");
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, 500),
    );
  }

  throw new Error("Next.js server did not become ready");
});

test.afterAll(async () => {
  try {
    if (
      server &&
      server.exitCode === null &&
      server.signalCode === null
    ) {
      server.kill("SIGTERM");
      await waitForExit(server);
    }

    await expect
      .poll(serverIsReachable, { timeout: 5_000 })
      .toBe(false);
  } finally {
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const HASH = "d".repeat(64);

type Provider = "openai" | "deepseek";
type Phase = "initial" | "installed" | "undone";

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function packageSkill(enabled: boolean) {
  return {
    id: "package-manager-policy",
    name: "Package Manager Policy",
    description: "Enforces pnpm for JavaScript dependency changes in the demo repository.",
    path: "skills/package-manager-policy",
    source: { type: "builtin", name: "package-manager-policy" },
    files: [{ path: "SKILL.md", hash: HASH }],
    scopes: { tasks: ["dependency-management"], fileGlobs: ["package.json", "pnpm-lock.yaml"] },
    workflows: [{ task: "dependency-management", executable: "pnpm", arguments: ["add"], lockfile: "pnpm-lock.yaml" }],
    enabled,
  };
}

function npmSkill(enabled: boolean) {
  return {
    id: "npm-workflow",
    name: "NPM Workflow",
    description: "Uses npm for JavaScript dependency changes in the demo repository.",
    path: "skills/npm-workflow",
    source: {
      type: "git",
      url: "https://github.com/example/skills.git",
      commit: "1".repeat(40),
      subdirectory: "skills/npm-workflow",
      license: "MIT",
    },
    files: [{ path: "SKILL.md", hash: "e".repeat(64) }],
    scopes: { tasks: ["dependency-management"], fileGlobs: ["package.json", "package-lock.json"] },
    workflows: [{ task: "dependency-management", executable: "npm", arguments: ["install"], lockfile: "package-lock.json" }],
    enabled,
  };
}

async function installDashboardMocks(page: Page, provider: Provider, undoConflict = false) {
  let phase: Phase = "initial";
  const loaded: Record<string, string> = { builder: A, reviewer: A };
  let transactions: Array<Record<string, unknown>> = [];

  const currentCommit = () => phase === "initial" ? A : phase === "installed" ? B : C;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();

    if (method === "GET" && pathname === "/api/registry") {
      return json(route, {
        configurationCommit: currentCommit(),
        skills: phase === "installed"
          ? [npmSkill(true), packageSkill(false)]
          : [packageSkill(true)],
        agents: [
          { id: "builder", name: "Builder", skills: [] },
          { id: "reviewer", name: "Reviewer", skills: [] },
        ],
      });
    }

    if (method === "GET" && pathname === "/api/transactions") {
      return json(route, { transactions });
    }

    const statusMatch = pathname.match(/^\/api\/agents\/(builder|reviewer)$/);
    if (method === "GET" && statusMatch) {
      const agentId = statusMatch[1];
      return json(route, {
        agentId,
        name: agentId === "builder" ? "Builder" : "Reviewer",
        loadedConfigurationCommit: loaded[agentId],
        activeSkillIds: loaded[agentId] === B ? ["npm-workflow"] : ["package-manager-policy"],
      });
    }

    const reloadMatch = pathname.match(/^\/api\/agents\/(builder|reviewer)\/reload$/);
    if (method === "POST" && reloadMatch) {
      const agentId = reloadMatch[1];
      loaded[agentId] = currentCommit();
      return json(route, { agentId, loadedConfigurationCommit: loaded[agentId] });
    }

    const runMatch = pathname.match(/^\/api\/agents\/(builder|reviewer)\/run$/);
    if (method === "POST" && runMatch) {
      const agentId = runMatch[1];
      const npm = loaded[agentId] === B;
      return json(route, {
        runId: `run-${agentId}-${loaded[agentId].slice(0, 4)}`,
        agentId,
        task: "add zod",
        configurationCommit: loaded[agentId],
        interceptedExecutable: npm ? "npm" : "pnpm",
        interceptedArguments: npm ? ["install", "zod"] : ["add", "zod"],
        expectedLockfile: npm ? "package-lock.json" : "pnpm-lock.yaml",
        status: "completed",
        timestamp: "2026-09-20T00:20:00.000Z",
      });
    }

    if (method === "POST" && pathname === "/api/imports/preview") {
      return json(route, {
        previewId: "preview-dashboard",
        transactionId: "tx-dashboard",
        baseCommit: A,
        incomingSkill: npmSkill(false),
        unifiedDiff: "diff --git a/agents.yaml b/agents.yaml\n- pnpm\n+ npm\n",
        resolutionDiffs: {
          "keep-existing": "diff --git a/skills/npm-workflow/SKILL.md b/skills/npm-workflow/SKILL.md\n+ npm workflow\n",
          "activate-incoming": "diff --git a/agents.yaml b/agents.yaml\n- pnpm\n+ npm\n",
        },
        conflicts: [{
          skillAId: "npm-workflow",
          skillBId: "package-manager-policy",
          analysis: {
            provider,
            model: provider === "openai" ? "mock-openai" : "mock-deepseek",
          },
          commonScenario: "Adding a JavaScript dependency",
          confidence: 0.99,
          explanation: "The incoming skill requires npm while the active policy requires pnpm.",
          evidence: [
            { skillId: "npm-workflow", filePath: "SKILL.md", lineStart: 16, lineEnd: 16, quote: "use `npm install`" },
            { skillId: "package-manager-policy", filePath: "SKILL.md", lineStart: 16, lineEnd: 16, quote: "use `pnpm add`" },
          ],
        }],
        allowedResolutions: ["keep-existing", "activate-incoming", "cancel"],
        createdAt: "2026-09-20T00:19:00.000Z",
      });
    }

    if (method === "POST" && pathname === "/api/transactions/install") {
      const requestBody = JSON.parse(request.postData() ?? "{}");
      if (requestBody.resolution === "cancel") {
        return json(route, { type: "cancelled", previewId: "preview-dashboard", transactionId: "tx-dashboard" });
      }
      phase = "installed";
      const install = {
        transactionId: "tx-dashboard",
        type: "install",
        resolution: requestBody.resolution,
        beforeCommit: A,
        afterCommit: B,
        affectedPathHashes: [{ path: "agents.yaml", beforeHash: HASH, afterHash: "e".repeat(64) }],
        createdAt: "2026-09-20T00:19:00.000Z",
      };
      transactions = [install];
      return json(route, install);
    }

    if (method === "POST" && pathname === "/api/transactions/tx-dashboard/undo") {
      if (undoConflict) {
        return json(route, {
          type: "conflict",
          transactionId: "tx-dashboard",
          message: "Automatic Undo stopped because one or more files changed after the installation transaction.",
          paths: ["agents.yaml"],
          files: [{
            path: "agents.yaml",
            beforeHash: HASH,
            expectedAfterHash: "e".repeat(64),
            currentHash: "f".repeat(64),
            beforeMode: "100644",
            expectedAfterMode: "100644",
            currentMode: "100644",
            before: "pnpm enabled",
            expectedAfter: "npm enabled",
            current: "custom later edit",
            threeWayDiff: "--- before\n||||||| expected\n======= current\n>>>>>>>",
          }],
        });
      }

      phase = "undone";
      const undo = {
        transactionId: "undo-dashboard",
        type: "undo",
        originalTransactionId: "tx-dashboard",
        beforeCommit: B,
        afterCommit: C,
        affectedPathHashes: [{ path: "agents.yaml", beforeHash: "e".repeat(64), afterHash: HASH }],
        createdAt: "2026-09-20T00:21:00.000Z",
      };
      transactions = [undo, transactions[0]];
      return json(route, { type: "committed", transaction: undo });
    }

    return json(route, { code: "UNMOCKED_ROUTE", message: `${method} ${pathname}` }, 500);
  });
}

async function fillPreviewForm(page: Page) {
  await page.getByLabel("Git URL").fill("https://github.com/example/skills.git");
  await page.getByLabel("Commit SHA").fill("1".repeat(40));
  await page.getByLabel("Skill subdirectory").fill("skills/npm-workflow");
  await page.getByRole("button", { name: "Generate preview" }).click();
}

for (const provider of ["openai", "deepseek"] as const) {
  test(`runs the full dashboard path with normalized ${provider} conflict output`, async ({ page }) => {
    await installDashboardMocks(page, provider);
    await page.goto("/");

    await expect(page.getByText("Managed repository connected")).toBeVisible();
    await expect(page.getByTestId("skill-package-manager-policy")).toContainText("Active");

    await fillPreviewForm(page);
    await expect(page.getByText("Adding a JavaScript dependency")).toBeVisible();
    await expect(page.getByText(provider === "openai" ? "OpenAI · mock-openai" : "DeepSeek · mock-deepseek")).toBeVisible();
    await expect(page.getByText("use `npm install`")).toBeVisible();
    await expect(page.getByText("use `pnpm add`")).toBeVisible();

    await page.getByRole("button", { name: "Activate incoming" }).click();
    await expect(page.getByText("diff --git a/agents.yaml b/agents.yaml")).toBeVisible();
    await page.getByRole("button", { name: "Review resolution" }).click();
    await page.getByRole("button", { name: "Confirm activate-incoming" }).click();

    await expect(page.getByTestId("skill-npm-workflow")).toContainText("Active");
    await expect(page.getByTestId("agent-builder")).toContainText("Stale");
    await expect(page.getByTestId("agent-reviewer")).toContainText("Stale");

    await page.getByTestId("agent-builder").getByRole("button", { name: "Run" }).click();
    await expect(page.getByTestId("agent-builder")).toContainText("pnpm add zod");

    await page.getByTestId("agent-builder").getByRole("button", { name: "Reload" }).click();
    await page.getByTestId("agent-reviewer").getByRole("button", { name: "Reload" }).click();
    await page.getByTestId("agent-builder").getByRole("button", { name: "Run" }).click();
    await page.getByTestId("agent-reviewer").getByRole("button", { name: "Run" }).click();
    await expect(page.getByTestId("agent-builder")).toContainText("npm install zod");
    await expect(page.getByTestId("agent-reviewer")).toContainText("npm install zod");

    await page.getByTestId("transaction-tx-dashboard").getByRole("button", { name: "Undo" }).click();
    await expect(page.getByTestId("skill-package-manager-policy")).toContainText("Active");
    await expect(page.getByTestId("agent-builder")).toContainText("Stale");

    await page.getByTestId("agent-builder").getByRole("button", { name: "Reload" }).click();
    await page.getByTestId("agent-reviewer").getByRole("button", { name: "Reload" }).click();
    await page.getByTestId("agent-builder").getByRole("button", { name: "Run" }).click();
    await page.getByTestId("agent-reviewer").getByRole("button", { name: "Run" }).click();
    await expect(page.getByTestId("agent-builder")).toContainText("pnpm add zod");
    await expect(page.getByTestId("agent-reviewer")).toContainText("pnpm add zod");
  });
}

test("surfaces stale, provider, and transaction failures with distinct dashboard states", async ({ page }) => {
  let previewFailure: string | null = "MODEL_PROVIDER_CREDENTIALS_MISSING";
  let installFailure: string | null = null;

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();

    if (method === "GET" && pathname === "/api/registry") {
      return json(route, { configurationCommit: A, skills: [packageSkill(true)], agents: [] });
    }
    if (method === "GET" && pathname === "/api/transactions") return json(route, { transactions: [] });
    if (method === "GET" && pathname.startsWith("/api/agents/")) {
      const id = pathname.endsWith("reviewer") ? "reviewer" : "builder";
      return json(route, { agentId: id, name: id, loadedConfigurationCommit: A, activeSkillIds: ["package-manager-policy"] });
    }

    if (method === "POST" && pathname === "/api/imports/preview") {
      if (previewFailure) {
        const status = previewFailure === "MODEL_PROVIDER_CREDENTIALS_MISSING" ? 503 : 502;
        return json(route, { code: previewFailure, message: `failure ${previewFailure}` }, status);
      }
      return json(route, {
        previewId: "preview-errors",
        transactionId: "tx-errors",
        baseCommit: A,
        incomingSkill: npmSkill(false),
        unifiedDiff: "diff --git a/agents.yaml b/agents.yaml\n- pnpm\n+ npm\n",
        resolutionDiffs: {
          "keep-existing": "keep diff",
          "activate-incoming": "activate diff",
        },
        conflicts: [],
        allowedResolutions: ["keep-existing", "activate-incoming", "cancel"],
        createdAt: "2026-09-20T00:19:00.000Z",
      });
    }

    if (method === "POST" && pathname === "/api/transactions/install") {
      const code = installFailure ?? "GIT_FAILED";
      return json(
        route,
        { code, message: `failure ${code}` },
        code === "PREVIEW_STALE" ? 409 : 400,
      );
    }

    return json(route, { code: "UNMOCKED_ROUTE", message: `${method} ${pathname}` }, 500);
  });

  await page.goto("/");
  await expect(page.getByText("No committed Skill Manager transactions yet.")).toBeVisible();

  await fillPreviewForm(page);
  await expect(page.locator('[data-error-kind="provider-credentials"]')).toContainText("Provider credentials");

  previewFailure = "MODEL_PROVIDER_TIMEOUT";
  await fillPreviewForm(page);
  await expect(page.locator('[data-error-kind="provider-analysis"]')).toContainText("Provider analysis");

  previewFailure = null;
  await fillPreviewForm(page);
  await page.getByRole("button", { name: "Activate incoming" }).click();
  await page.getByRole("button", { name: "Review resolution" }).click();

  installFailure = "PREVIEW_STALE";
  await page.getByRole("button", { name: "Confirm activate-incoming" }).click();
  await expect(page.locator('[data-error-kind="stale-preview"]')).toContainText("Stale preview");

  installFailure = "GIT_FAILED";
  await page.getByRole("button", { name: "Confirm activate-incoming" }).click();
  await expect(page.locator('[data-error-kind="transaction-error"]')).toContainText("Transaction error");
});

test("renders an Undo three-way conflict without hiding current repository state", async ({ page }) => {
  await installDashboardMocks(page, "openai", true);
  await page.goto("/");
  await fillPreviewForm(page);
  await page.getByRole("button", { name: "Activate incoming" }).click();
  await page.getByRole("button", { name: "Review resolution" }).click();
  await page.getByRole("button", { name: "Confirm activate-incoming" }).click();
  await page.getByTestId("transaction-tx-dashboard").getByRole("button", { name: "Undo" }).click();

  await expect(page.getByTestId("undo-conflict")).toContainText("Affected files changed");
  await expect(page.getByTestId("undo-conflict")).toContainText("pnpm enabled");
  await expect(page.getByTestId("undo-conflict")).toContainText("npm enabled");
  await expect(page.getByTestId("undo-conflict")).toContainText("custom later edit");
  await expect(page.getByTestId("skill-npm-workflow")).toContainText("Active");
});
