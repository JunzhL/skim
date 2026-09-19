import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { setupDemoRepository } from "../src/lib/demo-setup";

let root: string;
let server: ChildProcess;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "skim-e2e-"));
  const repo = setupDemoRepository(join(root, "demo"), { appRoot: process.cwd() });
  server = spawn(process.execPath, ["--experimental-strip-types", "scripts/start-next.mjs", "dev", "--turbopack", "--hostname", "127.0.0.1", "--port", "3100"], {
    cwd: process.cwd(),
    env: { ...process.env, SKIM_REPO_PATH: repo },
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

test.afterAll(() => {
  if (server && !server.killed) server.kill("SIGTERM");
  if (root) rmSync(root, { recursive: true, force: true });
});

test("shows connected Skill Manager shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Skill Manager" })).toBeVisible();
  await expect(page.getByText("Managed repository connected")).toBeVisible();
});
