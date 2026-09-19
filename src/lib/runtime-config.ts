import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const rawRuntimeConfigSchema = z.object({
  SKIM_REPO_PATH: z.string().min(1, "SKIM_REPO_PATH is required"),
  OPENAI_API_KEY: z.string().optional().transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }),
  OPENAI_MODEL: z.string().optional().default("gpt-5.6-terra").refine((value) => value.trim().length > 0, "OPENAI_MODEL cannot be blank"),
});

export type RuntimeConfig = {
  repoPath: string;
  openaiApiKey?: string;
  openaiModel: string;
};

function gitRoot(path: string): string | undefined {
  try {
    return realpathSync(execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return undefined;
  }
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function validateRuntimeConfig(
  env: Record<string, string | undefined>,
  options: { appRoot?: string } = {},
): RuntimeConfig {
  const raw = rawRuntimeConfigSchema.parse(env);
  if (!isAbsolute(raw.SKIM_REPO_PATH)) {
    throw new Error("SKIM_REPO_PATH must be an absolute path");
  }

  const requestedPath = resolve(raw.SKIM_REPO_PATH);
  if (!existsSync(requestedPath)) {
    throw new Error(`SKIM_REPO_PATH does not exist: ${requestedPath}`);
  }

  const repoPath = realpathSync(requestedPath);
  const appInput = realpathSync(/*turbopackIgnore: true*/ options.appRoot ?? process.cwd());
  const appRoot = gitRoot(appInput);
  if (appRoot && isSameOrDescendant(repoPath, appRoot)) {
    throw new Error("SKIM_REPO_PATH must not be the application repository or one of its descendants");
  }

  const managedRoot = gitRoot(repoPath);
  if (!managedRoot || managedRoot !== repoPath) {
    throw new Error("SKIM_REPO_PATH must point to the root of an existing Git repository");
  }

  return {
    repoPath,
    openaiApiKey: raw.OPENAI_API_KEY,
    openaiModel: raw.OPENAI_MODEL.trim(),
  };
}
