import { readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupDemoRepository } from "@/lib/demo-setup";
import { isSkimError, type SkimErrorCode } from "@/lib/errors";
import { importPinnedSkill } from "@/lib/skills/import";
import {
  cleanupTempDirectories,
  commitAll,
  copyInto,
  initRepository,
  remoteUrl,
  tempDirectory,
  workingTreeStatus,
  writeFile,
} from "../helpers/git-fixtures";

const pinnedFixture = JSON.parse(readFileSync("fixtures/pinned-skills/algorithmic-art.source.json", "utf8")) as {
  url: string;
  commit: string;
  subdirectory: string;
  license: string;
  licenseFiles: string[];
  files: { path: string; hash: string }[];
};

afterEach(cleanupTempDirectories);

function managedRepository(): string {
  return setupDemoRepository(join(tempDirectory("skim-managed-"), "demo"), { appRoot: process.cwd() });
}

function pinnedSourceRepository(): { url: string; commit: string } {
  const root = initRepository(tempDirectory("skim-source-"));
  copyInto(root, "skills/algorithmic-art", "fixtures/pinned-skills/algorithmic-art");
  return { url: remoteUrl(root), commit: commitAll(root, "add algorithmic-art") };
}

function hostileSourceRepository(): { url: string; commit: string; root: string } {
  const root = initRepository(tempDirectory("skim-hostile-"));
  writeFile(root, "skills/escaping-link/SKILL.md", "---\nname: escaping-link\ndescription: x\n---\n");
  symlinkSync("../../../../etc/passwd", join(root, "skills/escaping-link/passwd"));
  writeFile(root, "skills/inner-link/SKILL.md", "---\nname: inner-link\ndescription: x\n---\n");
  symlinkSync("SKILL.md", join(root, "skills/inner-link/alias.md"));
  writeFile(root, "skills/broken-metadata/SKILL.md", "---\nname: [unclosed\n---\n");
  writeFile(root, "skills/no-skill-file/README.md", "nothing here\n");
  return { url: remoteUrl(root), commit: commitAll(root, "add hostile fixtures"), root };
}

function skillDirectories(managed: string): string[] {
  return readdirSync(join(managed, "skills")).sort();
}

describe("pinned Git skill import", () => {
  it("copies every regular file from the pinned commit with stable hashes and provenance", () => {
    const managed = managedRepository();
    const source = pinnedSourceRepository();

    const imported = importPinnedSkill({
      source: { url: source.url, commit: source.commit, subdirectory: pinnedFixture.subdirectory },
      destinationRoot: managed,
    });

    expect(imported.slug).toBe("algorithmic-art");
    expect(imported.path).toBe("skills/algorithmic-art");
    expect(imported.files).toEqual(pinnedFixture.files);
    expect(imported.provenance).toEqual({
      type: "git",
      url: source.url,
      commit: source.commit,
      subdirectory: pinnedFixture.subdirectory,
      license: pinnedFixture.license,
      licenseFiles: pinnedFixture.licenseFiles,
    });

    const installed = join(managed, "skills/algorithmic-art");
    expect(readdirSync(installed).sort()).toEqual(["LICENSE.txt", "SKILL.md", "templates"]);
    expect(readdirSync(join(installed, "templates")).sort()).toEqual(["generator_template.js", "viewer.html"]);
    expect(readFileSync(join(installed, "LICENSE.txt"), "utf8")).toContain("Apache License");
    for (const file of pinnedFixture.files) {
      expect(readFileSync(join(installed, ...file.path.split("/")))).toEqual(
        readFileSync(join("fixtures/pinned-skills/algorithmic-art", ...file.path.split("/"))),
      );
    }
    expect(skillDirectories(managed)).toEqual(["algorithmic-art", "package-manager-policy"]);
  });

  it("produces the same hashes on every import of the same commit", () => {
    const source = pinnedSourceRepository();
    const request = { url: source.url, commit: source.commit, subdirectory: pinnedFixture.subdirectory };

    const first = importPinnedSkill({ source: request, destinationRoot: managedRepository() });
    const second = importPinnedSkill({ source: request, destinationRoot: managedRepository() });

    expect(second.files).toEqual(first.files);
    expect(second.provenance).toEqual(first.provenance);
  });

  it("detects a repeated import instead of overwriting the destination", () => {
    const managed = managedRepository();
    const source = pinnedSourceRepository();
    const request = { url: source.url, commit: source.commit, subdirectory: pinnedFixture.subdirectory };
    importPinnedSkill({ source: request, destinationRoot: managed });
    const installed = join(managed, "skills/algorithmic-art/SKILL.md");
    const before = readFileSync(installed, "utf8");

    expect(() => importPinnedSkill({ source: request, destinationRoot: managed })).toThrow(/already exists/);
    try {
      importPinnedSkill({ source: request, destinationRoot: managed });
    } catch (error) {
      expect(isSkimError(error, "DESTINATION_EXISTS")).toBe(true);
    }
    expect(readFileSync(installed, "utf8")).toBe(before);
    expect(skillDirectories(managed)).toEqual(["algorithmic-art", "package-manager-policy"]);
  });

  it("keeps imported content pinned when the source branch moves ahead", () => {
    const root = initRepository(tempDirectory("skim-moving-"));
    copyInto(root, "skills/algorithmic-art", "fixtures/pinned-skills/algorithmic-art");
    const pinnedCommit = commitAll(root, "pinned revision");

    writeFile(root, "skills/algorithmic-art/SKILL.md", "---\nname: algorithmic-art\ndescription: rewritten upstream.\n---\n\nrewritten\n");
    writeFile(root, "skills/algorithmic-art/templates/extra.js", "// added upstream\n");
    const movedCommit = commitAll(root, "move main ahead");
    expect(movedCommit).not.toBe(pinnedCommit);

    const managed = managedRepository();
    const imported = importPinnedSkill({
      source: { url: remoteUrl(root), commit: pinnedCommit, subdirectory: pinnedFixture.subdirectory },
      destinationRoot: managed,
    });

    expect(imported.files).toEqual(pinnedFixture.files);
    expect(readdirSync(join(managed, "skills/algorithmic-art/templates")).sort()).toEqual(["generator_template.js", "viewer.html"]);
    expect(readFileSync(join(managed, "skills/algorithmic-art/SKILL.md"), "utf8")).not.toContain("rewritten upstream");
  });
});

describe("pinned Git skill import rejections", () => {
  it.each<[string, SkimErrorCode, (fixture: { url: string; commit: string }) => { url: string; commit: string; subdirectory: string }]>([
    ["an absolute subdirectory", "INVALID_SOURCE", (f) => ({ ...f, subdirectory: "/etc" })],
    ["a traversing subdirectory", "INVALID_SOURCE", (f) => ({ ...f, subdirectory: "skills/../../etc" })],
    ["a Windows-separated subdirectory", "INVALID_SOURCE", (f) => ({ ...f, subdirectory: "skills\\escaping-link" })],
    ["a .git subdirectory segment", "INVALID_SOURCE", (f) => ({ ...f, subdirectory: "skills/.git/config" })],
    ["an unsupported protocol", "INVALID_SOURCE", (f) => ({ ...f, url: "http://example.com/repo.git", subdirectory: "skills/x" })],
    ["a short commit", "INVALID_SOURCE", (f) => ({ ...f, commit: "abc1234", subdirectory: "skills/inner-link" })],
    ["a commit missing from the source", "COMMIT_NOT_FOUND", (f) => ({ ...f, commit: "0".repeat(40), subdirectory: "skills/inner-link" })],
    ["a subdirectory missing at the commit", "SUBDIRECTORY_NOT_FOUND", (f) => ({ ...f, subdirectory: "skills/not-there" })],
    ["a symbolic link leaving the skill directory", "UNSAFE_SYMLINK", (f) => ({ ...f, subdirectory: "skills/escaping-link" })],
    ["a symbolic link inside the skill directory", "UNSUPPORTED_ENTRY", (f) => ({ ...f, subdirectory: "skills/inner-link" })],
    ["malformed SKILL.md frontmatter", "INVALID_FRONTMATTER", (f) => ({ ...f, subdirectory: "skills/broken-metadata" })],
    ["a directory without SKILL.md", "MISSING_SKILL_FILE", (f) => ({ ...f, subdirectory: "skills/no-skill-file" })],
  ])("rejects %s and leaves the managed repository unchanged", (_label, code, build) => {
    const managed = managedRepository();
    const hostile = hostileSourceRepository();

    let thrown: unknown;
    try {
      importPinnedSkill({ source: build({ url: hostile.url, commit: hostile.commit }), destinationRoot: managed });
    } catch (error) {
      thrown = error;
    }

    expect(isSkimError(thrown, code)).toBe(true);
    expect(workingTreeStatus(managed)).toBe("");
    expect(skillDirectories(managed)).toEqual(["package-manager-policy"]);
  });
});

describe("pinned upstream fixture", () => {
  it.skipIf(!process.env.SKIM_NETWORK_TESTS)(
    "matches the vendored anthropics/skills fixture when imported over the network",
    () => {
      const managed = managedRepository();
      const imported = importPinnedSkill({
        source: { url: pinnedFixture.url, commit: pinnedFixture.commit, subdirectory: pinnedFixture.subdirectory },
        destinationRoot: managed,
      });

      expect(imported.files).toEqual(pinnedFixture.files);
      expect(imported.provenance.license).toBe(pinnedFixture.license);
      expect(imported.provenance.licenseFiles).toEqual(pinnedFixture.licenseFiles);
    },
    180_000,
  );
});
