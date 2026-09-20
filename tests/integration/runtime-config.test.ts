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

  it("rejects the package directory and repositories nested inside it", () => {
    const root = tempRoot();
    const app = join(root, "app");
    gitRepo(app);
    const nested = join(app, "nested");
    gitRepo(nested);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: app }, { appRoot: app })).toThrow(/package directory/);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: nested }, { appRoot: app })).toThrow(/package directory/);
  });

  it("accepts the repository that contains an installed copy of the package", () => {
    const root = tempRoot();
    const consumer = join(root, "consumer");
    gitRepo(consumer);
    const installed = join(consumer, "node_modules", "skimctl");
    mkdirSync(installed, { recursive: true });

    // This is the published layout: the package lives inside the repository it manages.
    expect(validateRuntimeConfig({ SKIM_REPO_PATH: consumer }, { appRoot: installed }).repoPath).toBe(
      realpathSync(consumer),
    );
  });

  it("accepts both provider credentials and defaults to OpenAI", () => {
    const root = tempRoot();
    const app = join(root, "app");
    const target = join(root, "target");
    gitRepo(app);
    gitRepo(target);
    const parsed = validateRuntimeConfig(
      {
        SKIM_REPO_PATH: target,
        OPENAI_API_KEY: " openai-secret ",
        DEEPSEEK_API_KEY: " deepseek-secret ",
      },
      { appRoot: app },
    );
    expect(parsed.repoPath).toBe(realpathSync(target));
    expect(parsed.conflictModelProvider).toBe("openai");
    expect(parsed.openaiApiKey).toBe("openai-secret");
    expect(parsed.openaiModel).toBe("gpt-5.6-terra");
    expect(parsed.deepseekApiKey).toBe("deepseek-secret");
    expect(parsed.deepseekModel).toBe("deepseek-flash");
  });

  it("allows an explicit DeepSeek selection without requiring either key at startup", () => {
    const root = tempRoot();
    const app = join(root, "app");
    const target = join(root, "target");
    gitRepo(app);
    gitRepo(target);
    const parsed = validateRuntimeConfig(
      { SKIM_REPO_PATH: target, CONFLICT_MODEL_PROVIDER: "deepseek" },
      { appRoot: app },
    );
    expect(parsed.conflictModelProvider).toBe("deepseek");
    expect(parsed.openaiApiKey).toBeUndefined();
    expect(parsed.deepseekApiKey).toBeUndefined();
  });

  it("rejects invalid providers and blank model names", () => {
    const root = tempRoot();
    const app = join(root, "app");
    const target = join(root, "target");
    gitRepo(app);
    gitRepo(target);
    expect(() =>
      validateRuntimeConfig({ SKIM_REPO_PATH: target, CONFLICT_MODEL_PROVIDER: "other" }, { appRoot: app }),
    ).toThrow();
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: target, OPENAI_MODEL: "   " }, { appRoot: app })).toThrow(/OPENAI_MODEL/);
    expect(() => validateRuntimeConfig({ SKIM_REPO_PATH: target, DEEPSEEK_MODEL: "   " }, { appRoot: app })).toThrow(/DEEPSEEK_MODEL/);
  });
});
