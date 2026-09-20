import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { catalogEntrySchema, commitSchema, type BrowsedSkill, type CatalogEntry } from "../contracts";
import { SkimError } from "../errors";
import { gitTreeSource } from "../registry/tree-source";
import { parseSkillFrontmatter } from "../skills/frontmatter";
import { detectLicense } from "../skills/license";
import { assertAllowedGitUrl, fetchPinnedCommit } from "../skills/import";

export const CATALOG_FILE = "fixtures/catalog.json";

const MAX_BROWSED_SKILLS = 200;

const browseTargetSchema = z.object({ url: z.string().url(), commit: commitSchema });

const catalogFileSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(catalogEntrySchema),
});

export type BrowseRepositoryOptions = {
  url: string;
  commit: string;
  fetchTimeoutMs?: number;
  allowedProtocols?: string[];
};

/** The curated store front. Entries are pinned, so the list is stable across runs. */
export function readCuratedCatalog(root: string = process.cwd()): CatalogEntry[] {
  const path = join(root, ...CATALOG_FILE.split("/"));

  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SkimError("INVALID_CATALOG_FILE", `${CATALOG_FILE} could not be read`, {
      path: CATALOG_FILE,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = catalogFileSchema.safeParse(document);
  if (!parsed.success) {
    throw new SkimError("INVALID_CATALOG_FILE", `${CATALOG_FILE} does not match the catalog schema`, {
      path: CATALOG_FILE,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  const duplicate = parsed.data.entries.find(
    (entry, index) => parsed.data.entries.findIndex((other) => other.id === entry.id) !== index,
  );
  if (duplicate) {
    throw new SkimError("INVALID_CATALOG_FILE", `${CATALOG_FILE} lists ${duplicate.id} more than once`, { id: duplicate.id });
  }

  return parsed.data.entries;
}

/**
 * Lists every installable skill directory in one commit. Directories whose SKILL.md is missing or
 * malformed are skipped rather than failing the listing: a store front should still render.
 */
export function browseRepositorySkills(options: BrowseRepositoryOptions): BrowsedSkill[] {
  const parsed = browseTargetSchema.safeParse({ url: options.url, commit: options.commit });
  if (!parsed.success) {
    throw new SkimError("INVALID_SOURCE", "Browsing needs a Git URL and a full 40-character commit", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const source = parsed.data;
  assertAllowedGitUrl(source.url, options.allowedProtocols ?? ["https:", "file:"]);
  const checkout = fetchPinnedCommit(source, options.fetchTimeoutMs);

  try {
    const tree = gitTreeSource(checkout, source.commit);
    const skills: BrowsedSkill[] = [];

    for (const entry of tree.list()) {
      if (entry.kind !== "file" || !entry.path.endsWith("SKILL.md")) continue;
      const segments = entry.path.split("/");
      if (segments.length < 2 || segments.includes(".git")) continue;

      const subdirectory = segments.slice(0, -1).join("/");
      let frontmatter;
      try {
        frontmatter = parseSkillFrontmatter(tree.read(entry.fullPath).toString("utf8"), entry.path);
      } catch {
        continue;
      }

      const files = tree.list(subdirectory).filter((file) => file.kind === "file");
      skills.push({
        id: frontmatter.name,
        name: frontmatter.name,
        description: frontmatter.description,
        subdirectory,
        license: detectLicense(tree, subdirectory, frontmatter.license).expression,
        fileCount: files.length,
      });

      if (skills.length >= MAX_BROWSED_SKILLS) break;
    }

    return skills.sort((a, b) => (a.subdirectory < b.subdirectory ? -1 : 1));
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}
