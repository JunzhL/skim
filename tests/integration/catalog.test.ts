import { afterEach, describe, expect, it } from "vitest";
import { browseRepositorySkills, CATALOG_FILE, readCuratedCatalog } from "@/lib/catalog";
import { catalogEntrySchema, browsedSkillSchema } from "@/lib/contracts";
import { isSkimError } from "@/lib/errors";
import {
  cleanupTempDirectories,
  commitAll,
  copyInto,
  initRepository,
  remoteUrl,
  tempDirectory,
  writeFile,
} from "../helpers/git-fixtures";

afterEach(cleanupTempDirectories);

function storeRepository() {
  const root = initRepository(tempDirectory("skim-store-"));
  copyInto(root, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
  copyInto(root, "skills/algorithmic-art", "fixtures/pinned-skills/algorithmic-art");
  copyInto(root, "nested/deeper/package-manager-policy", "fixtures/demo-repo-template/skills/package-manager-policy");
  writeFile(root, "skills/broken/SKILL.md", "---\nname: [unterminated\n---\n");
  writeFile(root, "not-a-skill/README.md", "no frontmatter here\n");
  return { url: remoteUrl(root), commit: commitAll(root, "publish a skill store") };
}

describe("curated catalog", () => {
  it("reads pinned entries that match the API contract", () => {
    const entries = readCuratedCatalog();

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(catalogEntrySchema.safeParse(entry).success).toBe(true);
      expect(entry.source.url.startsWith("https://")).toBe(true);
      expect(entry.source.commit).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(entries.map((entry) => entry.id)).toContain("npm-workflow");
    expect(entries.map((entry) => entry.id)).toContain("algorithmic-art");
  });

  it("returns the same list on every read", () => {
    expect(readCuratedCatalog()).toEqual(readCuratedCatalog());
  });

  it("reports an unreadable catalog file instead of returning nothing", () => {
    try {
      readCuratedCatalog(tempDirectory("skim-no-catalog-"));
    } catch (error) {
      expect(isSkimError(error, "INVALID_CATALOG_FILE")).toBe(true);
      expect((error as Error).message).toContain(CATALOG_FILE);
    }
  });
});

describe("browsing a repository", () => {
  it("lists every installable skill directory at one commit", () => {
    const { url, commit } = storeRepository();
    const skills = browseRepositorySkills({ url, commit, allowedProtocols: ["file:"] });

    expect(skills.map((skill) => skill.subdirectory)).toEqual([
      "nested/deeper/package-manager-policy",
      "skills/algorithmic-art",
      "skills/npm-workflow",
    ]);
    for (const skill of skills) expect(browsedSkillSchema.safeParse(skill).success).toBe(true);

    const art = skills.find((skill) => skill.id === "algorithmic-art")!;
    expect(art).toMatchObject({ license: "Apache-2.0", fileCount: 4 });
    expect(skills.find((skill) => skill.id === "npm-workflow")).toMatchObject({ fileCount: 1, license: "unspecified" });
  });

  it("skips malformed and non-skill directories rather than failing the listing", () => {
    const { url, commit } = storeRepository();
    const ids = browseRepositorySkills({ url, commit, allowedProtocols: ["file:"] }).map((skill) => skill.id);

    expect(ids).not.toContain("broken");
    expect(ids).toHaveLength(3);
  });

  it("returns the same listing on every browse of the same commit", () => {
    const { url, commit } = storeRepository();
    const options = { url, commit, allowedProtocols: ["file:"] };
    expect(browseRepositorySkills(options)).toEqual(browseRepositorySkills(options));
  });

  it.each([
    ["a short commit", "abc1234"],
    ["a non-hex commit", "z".repeat(40)],
  ])("rejects %s", (_label, badCommit) => {
    const { url } = storeRepository();
    try {
      browseRepositorySkills({ url, commit: badCommit, allowedProtocols: ["file:"] });
    } catch (error) {
      expect(isSkimError(error, "INVALID_SOURCE")).toBe(true);
    }
  });

  it("rejects a protocol that is not allowed", () => {
    const { url, commit } = storeRepository();
    try {
      browseRepositorySkills({ url, commit, allowedProtocols: ["https:"] });
    } catch (error) {
      expect(isSkimError(error, "INVALID_SOURCE")).toBe(true);
      expect((error as Error).message).toContain("file:");
    }
  });

  it("reports a commit that is not in the repository", () => {
    const { url } = storeRepository();
    try {
      browseRepositorySkills({ url, commit: "0".repeat(40), allowedProtocols: ["file:"] });
    } catch (error) {
      expect(isSkimError(error, "COMMIT_NOT_FOUND")).toBe(true);
    }
  });
});
