import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/**
 * The directory of this package's own package.json.
 *
 * Skim refuses to manage its own source tree, and that check has to work in two very different
 * layouts: running from a clone, where the package root is the Git repository root, and running
 * from `node_modules/skimctl` inside somebody else's repository, where it is not. Anchoring on
 * the module's own location rather than the working directory is what keeps both correct.
 */
export function packageRoot(): string {
  if (cached) return cached;

  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (parsed.name) {
          cached = realpathSync(directory);
          return cached;
        }
      } catch {
        // Keep walking: an unreadable manifest is not this package's own.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  cached = realpathSync(process.cwd());
  return cached;
}
