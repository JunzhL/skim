import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const roots: string[] = [];

export function tempDirectory(prefix = "skim-test-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export function cleanupTempDirectories(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function initRepository(root: string): string {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Skim Test");
  git(root, "config", "user.email", "test@skim.local");
  git(root, "config", "commit.gpgSign", "false");
  return root;
}

export function writeFile(root: string, relativePath: string, content: string): void {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function copyInto(root: string, relativePath: string, sourceDirectory: string): void {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(sourceDirectory, target, { recursive: true });
}

export function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

export function remoteUrl(root: string): string {
  return pathToFileURL(root).href;
}

export function workingTreeStatus(root: string): string {
  return git(root, "status", "--porcelain");
}
