import type { SkillScopes } from "../contracts";

export type NormalizedScopes = { tasks: string[]; fileGlobs: string[] };

export type ScopeOverlap = {
  tasks: string[];
  fileGlobs: { a: string; b: string }[];
};

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeGlob(glob: string): string {
  return glob
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "");
}

export function normalizeScopes(scopes: SkillScopes): NormalizedScopes {
  return {
    tasks: unique(scopes.tasks.map((task) => task.trim().toLowerCase()).filter(Boolean)),
    fileGlobs: unique(scopes.fileGlobs.map(normalizeGlob).filter(Boolean)),
  };
}

function hasWildcard(glob: string): boolean {
  return /[*?[]/.test(glob);
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    pattern += character === "?" ? "[^/]" : character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

export function globsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (!hasWildcard(b) && globToRegExp(a).test(b)) return true;
  if (!hasWildcard(a) && globToRegExp(b).test(a)) return true;
  return false;
}

export function scopeOverlap(a: NormalizedScopes, b: NormalizedScopes): ScopeOverlap {
  const tasks = a.tasks.filter((task) => b.tasks.includes(task));
  const fileGlobs: { a: string; b: string }[] = [];
  for (const left of a.fileGlobs) {
    for (const right of b.fileGlobs) {
      if (globsOverlap(left, right)) fileGlobs.push({ a: left, b: right });
    }
  }
  return { tasks, fileGlobs };
}
