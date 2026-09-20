import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { commitSchema, relativePosixPathSchema, type GitProvenance, type SkillRecord } from "../contracts";
import { SkimError } from "../errors";
import { commitExists, tryGit } from "../git";
import { gitTreeSource, type TreeEntry, type TreeSource } from "../registry/tree-source";
import { detectLicense } from "./license";
import { parseSkillFrontmatter } from "./frontmatter";

const DEFAULT_ALLOWED_PROTOCOLS = ["https:", "file:"];
const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 16 * 1024 * 1024;

export const pinnedGitSourceSchema = z.object({
  url: z.string().url(),
  commit: commitSchema,
  subdirectory: relativePosixPathSchema,
});

export type PinnedGitSource = z.infer<typeof pinnedGitSourceSchema>;

export type ImportPinnedSkillOptions = {
  source: PinnedGitSource;
  destinationRoot: string;
  skillsDirectory?: string;
  allowedProtocols?: string[];
  fetchTimeoutMs?: number;
};

export type ImportedSkill = {
  slug: string;
  path: string;
  provenance: GitProvenance;
  files: SkillRecord["files"];
  frontmatter: { name: string; description: string; scopes: { tasks: string[]; fileGlobs: string[] } };
};

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function assertAllowedGitUrl(url: string, allowedProtocols: string[] = DEFAULT_ALLOWED_PROTOCOLS): void {
  const protocol = new URL(url).protocol;
  if (!allowedProtocols.includes(protocol)) {
    throw new SkimError("INVALID_SOURCE", `Unsupported Git URL protocol: ${protocol}`, { url, allowedProtocols });
  }
}

export function normalizePinnedSource(source: PinnedGitSource, allowedProtocols: string[] = DEFAULT_ALLOWED_PROTOCOLS): PinnedGitSource {
  const parsed = pinnedGitSourceSchema.safeParse(source);
  if (!parsed.success) {
    throw new SkimError("INVALID_SOURCE", "Import source is not a pinned Git URL, commit, and subdirectory", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }

  assertAllowedGitUrl(parsed.data.url, allowedProtocols);
  if (parsed.data.subdirectory.split("/").includes(".git")) {
    throw new SkimError("INVALID_SOURCE", "Skill subdirectory must not contain a .git segment", { subdirectory: parsed.data.subdirectory });
  }
  return parsed.data;
}

/** Fetches exactly one commit into a temporary bare repository. Callers must remove the returned path. */
export function fetchPinnedCommit(
  source: Pick<PinnedGitSource, "url" | "commit">,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): string {
  const checkout = mkdtempSync(join(tmpdir(), "skim-fetch-"));
  const init = tryGit(checkout, ["init", "-q", "--bare"]);
  if (!init.ok) {
    rmSync(checkout, { recursive: true, force: true });
    throw new SkimError("GIT_FAILED", `Could not create a temporary repository: ${init.stderr}`, {});
  }

  const pinned = tryGit(checkout, ["fetch", "-q", "--depth", "1", source.url, source.commit], timeoutMs);
  if (!commitExists(checkout, source.commit)) {
    const fallback = tryGit(checkout, ["fetch", "-q", source.url, "+refs/heads/*:refs/remotes/origin/*"], timeoutMs);
    if (!commitExists(checkout, source.commit)) {
      rmSync(checkout, { recursive: true, force: true });
      const reason = !fallback.ok ? fallback.stderr : !pinned.ok ? pinned.stderr : undefined;
      throw new SkimError("COMMIT_NOT_FOUND", `Commit ${source.commit} is not available in ${source.url}`, {
        url: source.url,
        commit: source.commit,
        reason: reason || undefined,
      });
    }
  }
  return checkout;
}

function escapesSkillDirectory(entryPath: string, target: string): boolean {
  if (target.startsWith("/")) return true;
  const segments = entryPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return true;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return false;
}

function readSafeEntries(entries: TreeEntry[], tree: TreeSource, subdirectory: string): Map<string, Buffer> {
  if (entries.length > MAX_SKILL_FILES) {
    throw new SkimError("SKILL_TOO_LARGE", `Skill directory has more than ${MAX_SKILL_FILES} entries`, { subdirectory, entries: entries.length });
  }

  const contents = new Map<string, Buffer>();
  let bytes = 0;

  for (const entry of entries) {
    const segments = entry.path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new SkimError("PATH_TRAVERSAL", `Skill file path escapes the skill directory: ${entry.path}`, { path: entry.path });
    }
    if (segments.includes(".git")) {
      throw new SkimError("NESTED_GIT_DIRECTORY", `Skill directory contains a nested Git directory: ${entry.path}`, { path: entry.path });
    }
    if (entry.kind === "symlink") {
      const target = tree.readLinkTarget(entry.fullPath);
      if (escapesSkillDirectory(entry.path, target)) {
        throw new SkimError("UNSAFE_SYMLINK", `Symbolic link leaves the skill directory: ${entry.path} -> ${target}`, { path: entry.path, target });
      }
      throw new SkimError("UNSUPPORTED_ENTRY", `Symbolic links are not supported: ${entry.path} -> ${target}`, { path: entry.path, target });
    }
    if (entry.kind !== "file") {
      throw new SkimError("UNSUPPORTED_ENTRY", `Skill directory contains an unsupported entry: ${entry.path}`, { path: entry.path, kind: entry.kind });
    }

    const content = tree.read(entry.fullPath);
    bytes += content.byteLength;
    if (bytes > MAX_SKILL_BYTES) {
      throw new SkimError("SKILL_TOO_LARGE", `Skill directory is larger than ${MAX_SKILL_BYTES} bytes`, { subdirectory });
    }
    contents.set(entry.path, content);
  }

  return contents;
}

export function importPinnedSkill(options: ImportPinnedSkillOptions): ImportedSkill {
  const source = normalizePinnedSource(options.source, options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS);
  const skillsDirectory = options.skillsDirectory ?? "skills";
  const checkout = fetchPinnedCommit(source, options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);

  try {
    const tree = gitTreeSource(checkout, source.commit);
    const entries = tree.list(source.subdirectory);
    if (entries.length === 0) {
      throw new SkimError("SUBDIRECTORY_NOT_FOUND", `${source.subdirectory} does not exist at ${source.commit}`, {
        subdirectory: source.subdirectory,
        commit: source.commit,
      });
    }

    const contents = readSafeEntries(entries, tree, source.subdirectory);
    const skillFile = contents.get("SKILL.md");
    if (!skillFile) {
      throw new SkimError("MISSING_SKILL_FILE", `${source.subdirectory} does not contain SKILL.md at ${source.commit}`, {
        subdirectory: source.subdirectory,
        commit: source.commit,
      });
    }

    const frontmatter = parseSkillFrontmatter(skillFile.toString("utf8"), `${source.subdirectory}/SKILL.md`);
    const slug = frontmatter.name;
    const relativeDestination = `${skillsDirectory}/${slug}`;
    const destination = join(options.destinationRoot, skillsDirectory, slug);
    if (existsSync(/*turbopackIgnore: true*/ destination)) {
      throw new SkimError("DESTINATION_EXISTS", `${relativeDestination} already exists in the managed repository`, { path: relativeDestination, slug });
    }

    const license = detectLicense(tree, source.subdirectory, frontmatter.license);
    const files = [...contents]
      .map(([path, content]) => ({ path, hash: sha256(content) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));

    mkdirSync(/*turbopackIgnore: true*/ join(options.destinationRoot, skillsDirectory), { recursive: true });
    const staging = mkdtempSync(/*turbopackIgnore: true*/ join(options.destinationRoot, skillsDirectory, `.skim-import-${slug}-`));
    try {
      for (const entry of entries) {
        const target = join(staging, ...entry.path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents.get(entry.path)!);
        if (entry.executable) chmodSync(target, 0o755);
      }
      renameSync(staging, destination);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }

    return {
      slug,
      path: relativeDestination,
      provenance: {
        type: "git",
        url: source.url,
        commit: source.commit,
        subdirectory: source.subdirectory,
        license: license.expression,
        licenseFiles: license.files,
      },
      files,
      frontmatter: { name: frontmatter.name, description: frontmatter.description, scopes: frontmatter.scopes },
    };
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}
