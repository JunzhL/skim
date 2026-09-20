import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WRAPPER = resolve(process.cwd(), "scripts/start-next.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skim-startup-test-")));
  roots.push(root);
  return root;
}

function managedRepository(root: string): string {
  const path = join(root, "managed");
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
  return path;
}

/** Runs the wrapper from `cwd` with `next` off PATH, so launching Next.js is the only step that can fail. */
function runWrapper(cwd: string, overrides: Record<string, string> = {}, command = "dev") {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "/usr/bin:/bin" };
  delete env.SKIM_REPO_PATH;
  return spawnSync(process.execPath, ["--experimental-strip-types", WRAPPER, command], {
    cwd,
    env: { ...env, ...overrides },
    encoding: "utf8",
  });
}

describe("startup wrapper", () => {
  it("exits before launching Next.js when managed-repository validation fails", () => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/start-next.mjs", "dev"], {
      cwd: process.cwd(),
      env: { ...process.env, SKIM_REPO_PATH: "" },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid runtime configuration");
    expect(result.stderr).toContain("SKIM_REPO_PATH");
    expect(result.stdout).not.toContain("Next.js");
  });

  it("reads SKIM_REPO_PATH from .env.local before validating", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".env.local"), `SKIM_REPO_PATH=${managedRepository(root)}\n`);

    const result = runWrapper(root);

    expect(result.stderr).not.toContain("Invalid runtime configuration");
    expect(result.stderr).toContain("Failed to start Next.js");
  });

  it.each(["dev", "start"])("reads .env for %s as well as .env.local", (command) => {
    const root = tempRoot();
    writeFileSync(join(root, ".env"), `SKIM_REPO_PATH=${managedRepository(root)}\n`);

    expect(runWrapper(root, {}, command).stderr).not.toContain("Invalid runtime configuration");
  });

  it("lets the real environment win over the env files", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".env.local"), `SKIM_REPO_PATH=${managedRepository(root)}\n`);

    const result = runWrapper(root, { SKIM_REPO_PATH: join(root, "not-a-repository") });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid runtime configuration");
    expect(result.stderr).toContain("does not exist");
  });

  it("prefers .env.local over .env", () => {
    const root = tempRoot();
    writeFileSync(join(root, ".env.local"), `SKIM_REPO_PATH=${managedRepository(root)}\n`);
    writeFileSync(join(root, ".env"), `SKIM_REPO_PATH=${join(root, "not-a-repository")}\n`);

    expect(runWrapper(root).stderr).not.toContain("Invalid runtime configuration");
  });

  it("still reports a missing SKIM_REPO_PATH when no env file supplies one", () => {
    const result = runWrapper(tempRoot());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid runtime configuration");
    expect(result.stderr).toContain("SKIM_REPO_PATH");
  });
});
