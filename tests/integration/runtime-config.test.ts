import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateRuntimeConfig } from "@/lib/runtime-config";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skim-config-test-"));
  roots.push(root);
  return root;
}

function gitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
}

describe("runtime configuration", () => {
  it("rejects missing and relative SKIM_REPO_PATH", () => {
    const root = tempRoot();
    expect(() => validateRuntimeConfig({}, { appRoot: root })).toThrow(/SKIM_REPO_PATH/);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: "relative/repo" }, { appRoot: root })).toThrow(/absolute/);
  });

  it("rejects missing and non-Git directories", () => {
    const root = tempRoot();
    const missing = join(root, "missing");
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: missing }, { appRoot: root })).toThrow(/does not exist/);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: plain }, { appRoot: root })).toThrow(/root of an existing Git repository/);
  });

  it("rejects the app repository and descendants", () => {
    const root = tempRoot();
    const app = join(root, "app");
    gitRepo(app);
    const child = join(app, "child");
    mkdirSync(child);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: app }, { appRoot: app })).toThrow(/application repository/);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: child }, { appRoot: app })).toThrow(/application repository/);
  });

  it("accepts an independent repository and optional API key", () => {
    const root = tempRoot();
    const app = join(root, "app");
    const target = join(root, "target");
    gitRepo(app);
    gitRepo(target);
    const parsed = validateRuntimeConfig({ SKIM_REPO_PATH: target, OPENAI_API_KEY: "", OPENAI_MODEL: undefined }, { appRoot: app });
    expect(parsed.repoPath).toBe(realpathSync(target));
    expect(parsed.openaiApiKey).toBeUndefined();
    expect(parsed.openaiModel).toBe("gpt-5.6-terra");
    expect(validateRuntimeConfig({ SKIM_REPO_PATH: target, OPENAI_API_KEY: "secret" }, { appRoot: app }).openaiApiKey).toBe("secret");
  });

  it("rejects a blank model name", () => {
    const root = tempRoot();
    const app = join(root, "app");
    const target = join(root, "target");
    gitRepo(app);
    gitRepo(target);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: target, OPENAI_MODEL: "   " }, { appRoot: app })).toThrow(/OPENAI_MODEL/);
  });
});
