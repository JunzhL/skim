import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

const optionalSecretSchema = z.string().optional().transform((value) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
});

function modelSchema(environmentName: string, fallback: string) {
  return z
    .string()
    .optional()
    .default(fallback)
    .refine((value) => value.trim().length > 0, `${environmentName} cannot be blank`);
}

const rawRuntimeConfigSchema = z.object({
  SKIM_REPO_PATH: z.string().min(1, "SKIM_REPO_PATH is required"),
  CONFLICT_MODEL_PROVIDER: z.enum(["openai", "deepseek"]).optional().default("openai"),
  OPENAI_API_KEY: optionalSecretSchema,
  OPENAI_MODEL: modelSchema("OPENAI_MODEL", "gpt-5.6-terra"),
  DEEPSEEK_API_KEY: optionalSecretSchema,
  DEEPSEEK_MODEL: modelSchema("DEEPSEEK_MODEL", "deepseek-flash"),
});

export type ConflictModelProvider = "openai" | "deepseek";

export type RuntimeConfig = {
  repoPath: string;
  conflictModelProvider: ConflictModelProvider;
  openaiApiKey?: string;
  openaiModel: string;
  deepseekApiKey?: string;
  deepseekModel: string;
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
    conflictModelProvider: raw.CONFLICT_MODEL_PROVIDER,
    openaiApiKey: raw.OPENAI_API_KEY,
    openaiModel: raw.OPENAI_MODEL.trim(),
    deepseekApiKey: raw.DEEPSEEK_API_KEY,
    deepseekModel: raw.DEEPSEEK_MODEL.trim(),
  };
}
