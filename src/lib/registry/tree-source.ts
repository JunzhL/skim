import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitBuffer } from "../git";

export type TreeEntryKind = "file" | "symlink" | "submodule" | "other";

export type TreeEntry = {
  path: string;
  fullPath: string;
  kind: TreeEntryKind;
  executable: boolean;
};

export interface TreeSource {
  readonly describe: string;
  list(prefix?: string): TreeEntry[];
  directories(prefix: string): string[];
  read(fullPath: string): Buffer;
  readLinkTarget(fullPath: string): string;
  exists(fullPath: string): boolean;
}

function scope(entries: TreeEntry[], prefix: string): TreeEntry[] {
  if (prefix === "") return entries;
  const withSlash = `${prefix}/`;
  return entries
    .filter((entry) => entry.fullPath.startsWith(withSlash))
    .map((entry) => ({ ...entry, path: entry.fullPath.slice(withSlash.length) }));
}

function immediateDirectories(entries: TreeEntry[], prefix: string): string[] {
  const names = new Set<string>();
  for (const entry of scope(entries, prefix)) {
    const [head, ...rest] = entry.path.split("/");
    if (rest.length > 0 && head) names.add(head);
  }
  return [...names].sort();
}

export function gitTreeSource(repoRoot: string, commit: string): TreeSource {
  let cache: { entries: TreeEntry[]; objects: Map<string, string> } | undefined;

  function load() {
    if (cache) return cache;
    const raw = gitBuffer(repoRoot, ["ls-tree", "-r", "-z", "--full-tree", commit]).toString("utf8");
    const entries: TreeEntry[] = [];
    const objects = new Map<string, string>();
    for (const record of raw.split("\0")) {
      if (record === "") continue;
      const tab = record.indexOf("\t");
      const [mode, , object] = record.slice(0, tab).split(" ");
      const fullPath = record.slice(tab + 1);
      const kind: TreeEntryKind =
        mode === "100644" || mode === "100755" ? "file" : mode === "120000" ? "symlink" : mode === "160000" ? "submodule" : "other";
      entries.push({ path: fullPath, fullPath, kind, executable: mode === "100755" });
      objects.set(fullPath, object);
    }
    entries.sort((a, b) => (a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0));
    cache = { entries, objects };
    return cache;
  }

  function object(fullPath: string): string {
    const found = load().objects.get(fullPath);
    if (!found) throw new Error(`Path not present in ${commit}: ${fullPath}`);
    return found;
  }

  return {
    describe: `${repoRoot}@${commit}`,
    list: (prefix = "") => scope(load().entries, prefix),
    directories: (prefix) => immediateDirectories(load().entries, prefix),
    read: (fullPath) => gitBuffer(repoRoot, ["cat-file", "blob", object(fullPath)]),
    readLinkTarget: (fullPath) => gitBuffer(repoRoot, ["cat-file", "blob", object(fullPath)]).toString("utf8"),
    exists: (fullPath) => load().objects.has(fullPath),
  };
}

export function fsTreeSource(root: string): TreeSource {
  let cache: TreeEntry[] | undefined;

  function walk(relative: string, into: TreeEntry[]): void {
    const absolute = relative === "" ? root : join(root, relative);
    for (const item of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (item.name === ".git") continue;
      const fullPath = relative === "" ? item.name : `${relative}/${item.name}`;
      if (item.isDirectory()) {
        walk(fullPath, into);
        continue;
      }
      const kind: TreeEntryKind = item.isSymbolicLink() ? "symlink" : item.isFile() ? "file" : "other";
      const executable = kind === "file" ? (statSync(join(root, fullPath)).mode & 0o111) !== 0 : false;
      into.push({ path: fullPath, fullPath, kind, executable });
    }
  }

  function load(): TreeEntry[] {
    if (!cache) {
      const entries: TreeEntry[] = [];
      walk("", entries);
      cache = entries;
    }
    return cache;
  }

  return {
    describe: root,
    list: (prefix = "") => scope(load(), prefix),
    directories: (prefix) => immediateDirectories(load(), prefix),
    read: (fullPath) => readFileSync(join(root, fullPath)),
    readLinkTarget: (fullPath) => readlinkSync(join(root, fullPath)),
    exists: (fullPath) => load().some((entry) => entry.fullPath === fullPath),
  };
}
