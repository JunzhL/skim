import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { setupDemoRepository } from "../src/lib/demo-setup";

let root: string;
let repository: string;
let server: ChildProcess;

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("Next.js server did not stop")), 10_000);
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
    await fetch("http://127.0.0.1:3100", { signal: AbortSignal.timeout(250) });
    return true;
  } catch {
    return false;
  }
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "skim-e2e-"));
  repository = setupDemoRepository(join(root, "demo"), { appRoot: process.cwd() });
  server = spawn(process.execPath, ["--experimental-strip-types", "scripts/start-next.mjs", "dev", "--turbopack", "--hostname", "127.0.0.1", "--port", "3100"], {
    cwd: process.cwd(),
    env: { ...process.env, SKIM_REPO_PATH: repository },
    stdio: "ignore",
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:3100");
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("Next.js server did not become ready");
});

test.afterAll(async () => {
  try {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGTERM");
      await waitForExit(server);
    }
    await expect.poll(serverIsReachable, { timeout: 5_000 }).toBe(false);
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

test("shows connected Skill Manager shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Skill Manager" })).toBeVisible();
  await expect(page.getByText("Managed repository connected")).toBeVisible();
});

test("serves the committed registry at the managed repository HEAD", async ({ request }) => {
  const response = await request.get("/api/registry");
  expect(response.ok()).toBe(true);

  const body = await response.json();
  expect(body.configurationCommit).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim());
  expect(body.skills.map((skill: { id: string }) => skill.id)).toEqual(["package-manager-policy"]);
  expect(body.skills[0]).toMatchObject({ source: { type: "builtin", name: "package-manager-policy" }, enabled: true });
  expect(body.agents.map((agent: { id: string }) => agent.id)).toEqual(["builder", "reviewer"]);
});
