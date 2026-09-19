import { execFileSync } from "node:child_process";
import { SkimError } from "./errors";

const MAX_BUFFER = 64 * 1024 * 1024;

export type GitResult = { ok: true; stdout: Buffer } | { ok: false; stderr: string };

export function tryGit(cwd: string, args: string[], timeoutMs?: number): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stderr: (stderr ? stderr.toString() : message).trim() };
  }
}

export function gitBuffer(cwd: string, args: string[], timeoutMs?: number): Buffer {
  const result = tryGit(cwd, args, timeoutMs);
  if (!result.ok) {
    throw new SkimError("GIT_FAILED", `git ${args.join(" ")} failed: ${result.stderr}`, { args, stderr: result.stderr });
  }
  return result.stdout;
}

export function git(cwd: string, args: string[], timeoutMs?: number): string {
  return gitBuffer(cwd, args, timeoutMs).toString("utf8").trim();
}

export function repositoryRoot(path: string): string {
  const result = tryGit(path, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) {
    throw new SkimError("NOT_A_GIT_REPOSITORY", `Not a Git repository: ${path}`, { path });
  }
  return result.stdout.toString("utf8").trim();
}

export function headCommit(repoRoot: string): string {
  const result = tryGit(repoRoot, ["rev-parse", "HEAD"]);
  if (!result.ok) {
    throw new SkimError("EMPTY_HISTORY", `Repository has no commits: ${repoRoot}`, { repoRoot });
  }
  return result.stdout.toString("utf8").trim();
}

export function commitExists(repoRoot: string, commit: string): boolean {
  return tryGit(repoRoot, ["cat-file", "-e", `${commit}^{commit}`]).ok;
}
