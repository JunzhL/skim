import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupDemoRepository } from "@/lib/demo-setup";
import { parseSkillFrontmatter } from "@/lib/skills/frontmatter";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skim-demo-test-"));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("demo setup", () => {
  it("creates one committed main-branch repository with local identity and active assignments", () => {
    const root = tempRoot();
    const destination = join(root, "demo");
    const result = setupDemoRepository(destination, { appRoot: process.cwd() });
    expect(result).toBe(join(realpathSync(root), "demo"));
    expect(readFileSync(join(destination, "skills/package-manager-policy/SKILL.md"), "utf8")).toContain("use `pnpm add` and keep `pnpm-lock.yaml` updated.");
    const skill = readFileSync(join(destination, "skills/package-manager-policy/SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: package-manager-policy\ndescription: .+\n/);
    expect(parseSkillFrontmatter(skill, "SKILL.md")).toMatchObject({
      name: "package-manager-policy",
      scopes: { tasks: ["dependency-management"], fileGlobs: ["package.json", "pnpm-lock.yaml"] },
      workflows: [{ task: "dependency-management", executable: "pnpm", arguments: ["add"], lockfile: "pnpm-lock.yaml" }],
    });
    const agents = readFileSync(join(destination, "agents.yaml"), "utf8");
    expect(agents.match(/skillId: package-manager-policy/g)).toHaveLength(2);
    expect(agents.match(/enabled: true/g)).toHaveLength(2);
    expect(agents.match(/priority: 100/g)).toHaveLength(2);
    expect(git(destination, "branch", "--show-current")).toBe("main");
    expect(git(destination, "config", "user.name")).toBe("Skim Demo");
    expect(git(destination, "config", "user.email")).toBe("demo@skim.local");
    expect(git(destination, "config", "commit.gpgSign")).toBe("false");
    expect(git(destination, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("refuses existing destinations", () => {
    const root = tempRoot();
    expect(() => setupDemoRepository(root, { appRoot: process.cwd() })).toThrow(/already exists|application repository/);
  });

  it("refuses a destination whose parent symlink resolves inside the application repository", () => {
    const root = tempRoot();
    const linkedParent = join(root, "linked-parent");
    symlinkSync(process.cwd(), linkedParent, "dir");

    expect(() => setupDemoRepository(join(linkedParent, "demo"), { appRoot: process.cwd() })).toThrow(/application repository/);
  });

  it("cleans only its temporary directory after a forced failure", () => {
    const root = tempRoot();
    const destination = join(root, "demo");
    expect(() => setupDemoRepository(destination, { appRoot: process.cwd(), failAfterCopy: true })).toThrow(/Forced/);
    expect(() => readFileSync(join(destination, "agents.yaml"), "utf8")).toThrow();
    expect(readdirSync(root).some((name) => name.startsWith(".skim-demo-tmp-"))).toBe(false);
  });
});
