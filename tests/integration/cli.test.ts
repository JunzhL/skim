import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { agentsFileSchema } from "@/lib/contracts";

const CLI = resolve(process.cwd(), "bin/skimctl.mjs");
const roots: string[] = [];

beforeAll(() => {
  // The CLI loads compiled JavaScript: Node refuses to strip types under node_modules, so the
  // published package cannot ship the TypeScript sources the rest of the app imports.
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: process.cwd(), stdio: "pipe" });
}, 120_000);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = realpathSync(mkdtempSync());
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return root;
}

function mkdtempSync(): string {
  const root = join(tmpdir(), `skim-cli-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

describe("skimctl", () => {
  it("runs under plain Node without a type-stripping flag", () => {
    const result = runCli(["--help"], process.cwd());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("skimctl");
    expect(result.stderr).toBe("");
  });

  it("creates a usable managed repository and is safe to repeat", () => {
    const root = repository();

    const first = runCli(["init"], root);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("created  agents.yaml");
    expect(first.stdout).toContain("created  skills/");

    const agents = parseYaml(readFileSync(join(root, "agents.yaml"), "utf8"));
    expect(agentsFileSchema.safeParse(agents).success).toBe(true);
    expect(existsSync(join(root, "skills/.gitkeep"))).toBe(true);

    const second = runCli(["init"], root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("exists   agents.yaml");
  });

  it("refuses to initialise something that is not a repository", () => {
    const result = runCli(["init"], mkdtempSync());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Not inside a Git repository");
  });

  it("targets an explicit repository with --repo", () => {
    const root = repository();
    const elsewhere = mkdtempSync();

    expect(runCli(["init", "--repo", root], elsewhere).status).toBe(0);
    expect(existsSync(join(root, "agents.yaml"))).toBe(true);
  });

  it("reports an unknown command instead of starting a server", () => {
    const result = runCli(["explode"], repository());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command: explode");
  });

  it("tells the user to run init when the repository has no agents.yaml", () => {
    const result = runCli(["start"], repository());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("skimctl init");
  });
});
