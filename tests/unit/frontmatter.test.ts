import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseSkillFrontmatter } from "@/lib/skills/frontmatter";
import { detectLicense } from "@/lib/skills/license";
import { fsTreeSource } from "@/lib/registry/tree-source";
import { isSkimError } from "@/lib/errors";

const minimal = ["---", "name: npm-workflow", "description: Use npm for dependency changes.", "---", "", "# NPM Workflow", ""].join("\n");

describe("SKILL.md frontmatter", () => {
  it("parses required metadata and defaults empty scopes", () => {
    const parsed = parseSkillFrontmatter(minimal, "skills/npm-workflow/SKILL.md");
    expect(parsed.name).toBe("npm-workflow");
    expect(parsed.description).toBe("Use npm for dependency changes.");
    expect(parsed.scopes).toEqual({ tasks: [], fileGlobs: [] });
    expect(parsed.license).toBeUndefined();
  });

  it("parses declared scopes, a license, and unknown keys", () => {
    const content = [
      "---",
      "name: npm-workflow",
      "description: Use npm.",
      "license: MIT",
      "allowed-tools: [Bash]",
      "scopes:",
      "  tasks: [dependency-management]",
      "  fileGlobs: ['package.json']",
      "---",
      "body",
    ].join("\n");
    const parsed = parseSkillFrontmatter(content, "SKILL.md");
    expect(parsed.scopes).toEqual({ tasks: ["dependency-management"], fileGlobs: ["package.json"] });
    expect(parsed.license).toBe("MIT");
    expect(parsed["allowed-tools"]).toEqual(["Bash"]);
  });

  it.each([
    ["no frontmatter", "# Just a heading\n"],
    ["unterminated block", "---\nname: a\ndescription: b\n"],
    ["malformed yaml", "---\nname: [unclosed\n---\n"],
    ["sequence instead of mapping", "---\n- a\n- b\n---\n"],
    ["missing description", "---\nname: npm-workflow\n---\n"],
    ["blank description", "---\nname: npm-workflow\ndescription: ''\n---\n"],
    ["non-identifier name", "---\nname: NPM Workflow\ndescription: x\n---\n"],
    ["invalid scopes", "---\nname: a\ndescription: x\nscopes:\n  tasks: 'not-a-list'\n---\n"],
  ])("rejects %s", (_label, content) => {
    expect(() => parseSkillFrontmatter(content, "SKILL.md")).toThrow();
    try {
      parseSkillFrontmatter(content, "SKILL.md");
    } catch (error) {
      expect(isSkimError(error, "INVALID_FRONTMATTER")).toBe(true);
    }
  });

  it("accepts the pinned algorithmic-art metadata", () => {
    const content = readFileSync("fixtures/pinned-skills/algorithmic-art/SKILL.md", "utf8");
    const parsed = parseSkillFrontmatter(content, "skills/algorithmic-art/SKILL.md");
    expect(parsed.name).toBe("algorithmic-art");
    expect(parsed.license).toBe("Complete terms in LICENSE.txt");
    expect(parsed.scopes).toEqual({ tasks: [], fileGlobs: [] });
  });
});

describe("license detection", () => {
  it("identifies Apache-2.0 from the preserved license file", () => {
    const source = fsTreeSource("fixtures/pinned-skills");
    expect(detectLicense(source, "algorithmic-art", "Complete terms in LICENSE.txt")).toEqual({
      expression: "Apache-2.0",
      files: ["LICENSE.txt"],
    });
  });

  it("falls back to the declared license and then to unspecified", () => {
    const source = fsTreeSource("fixtures/demo-repo-template");
    expect(detectLicense(source, "skills/package-manager-policy", "MIT")).toEqual({ expression: "MIT", files: [] });
    expect(detectLicense(source, "skills/package-manager-policy")).toEqual({ expression: "unspecified", files: [] });
  });
});
