import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkimError } from "./errors.ts";

// Duplicated from registry/build.ts on purpose: the CLI loads this module with plain Node, which
// cannot resolve that module's directory imports. tests/integration/cli.test.ts guards the pair.
const AGENTS_FILE = "agents.yaml";
const SKILLS_DIRECTORY = "skills";

const STARTER_AGENTS = `schemaVersion: 1
agents:
  - id: builder
    name: Builder
    skills: []
  - id: reviewer
    name: Reviewer
    skills: []
`;

export type InitResult = { created: string[]; skipped: string[] };

/**
 * Creates the two files Skim needs to read a repository: an agents manifest and a skills directory.
 * Existing files are never overwritten, so running this twice is safe.
 */
export function initialiseManagedRepository(repoPath: string): InitResult {
  if (!existsSync(join(repoPath, ".git"))) {
    throw new SkimError("NOT_A_GIT_REPOSITORY", `${repoPath} is not the root of a Git repository`, { repoPath });
  }

  const created: string[] = [];
  const skipped: string[] = [];

  const agents = join(repoPath, AGENTS_FILE);
  if (existsSync(agents)) {
    skipped.push(AGENTS_FILE);
  } else {
    writeFileSync(agents, STARTER_AGENTS);
    created.push(AGENTS_FILE);
  }

  const skills = join(repoPath, SKILLS_DIRECTORY);
  if (existsSync(skills)) {
    skipped.push(`${SKILLS_DIRECTORY}/`);
  } else {
    mkdirSync(skills, { recursive: true });
    writeFileSync(join(skills, ".gitkeep"), "");
    created.push(`${SKILLS_DIRECTORY}/`);
  }

  return { created, skipped };
}
