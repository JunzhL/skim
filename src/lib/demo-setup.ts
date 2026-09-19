import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type DemoSetupOptions = {
  appRoot: string;
  templatePath?: string;
  failAfterCopy?: boolean;
};

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function setupDemoRepository(destinationInput: string, options: DemoSetupOptions): string {
  const appRoot = realpathSync(options.appRoot);
  const destination = resolve(destinationInput);

  if (isSameOrDescendant(destination, appRoot)) {
    throw new Error("Demo repository destination must not be the application repository or one of its descendants");
  }
  if (existsSync(destination)) {
    throw new Error(`Destination already exists: ${destination}`);
  }

  const parent = dirname(destination);
  if (!existsSync(parent)) {
    throw new Error(`Destination parent does not exist: ${parent}`);
  }

  const templatePath = options.templatePath ?? resolve(appRoot, "fixtures/demo-repo-template");
  const temporary = mkdtempSync(resolve(parent, ".skim-demo-tmp-"));

  try {
    cpSync(templatePath, temporary, { recursive: true });
    if (options.failAfterCopy) {
      throw new Error("Forced demo setup failure");
    }
    runGit(temporary, ["init", "-b", "main"]);
    runGit(temporary, ["config", "user.name", "Skim Demo"]);
    runGit(temporary, ["config", "user.email", "demo@skim.local"]);
    runGit(temporary, ["config", "commit.gpgSign", "false"]);
    runGit(temporary, ["add", "."]);
    runGit(temporary, ["commit", "-m", "chore: initialize skim demo repository"]);
    renameSync(temporary, destination);
    return destination;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
