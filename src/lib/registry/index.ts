import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentConfig, SkillRecord } from "../contracts";
import { headCommit, repositoryRoot } from "../git";
import { buildRegistrySnapshot, REGISTRY_FILE, type BuildRegistryOptions, type RegistrySnapshot, type SkillSource } from "./build";
import { fsTreeSource, gitTreeSource } from "./tree-source";

export { AGENTS_FILE, REGISTRY_FILE, SKILLS_DIRECTORY, buildRegistrySnapshot, registryFileSchema } from "./build";
export type { BuildRegistryOptions, RegistryFile, RegistrySnapshot, SkillSource } from "./build";
export { fsTreeSource, gitTreeSource } from "./tree-source";
export type { TreeEntry, TreeEntryKind, TreeSource } from "./tree-source";

export type Registry = RegistrySnapshot & { configurationCommit: string };

export function readRegistry(repoPath: string, options: BuildRegistryOptions = {}): Registry {
  const root = repositoryRoot(repoPath);
  const configurationCommit = headCommit(root);
  return { configurationCommit, ...buildRegistrySnapshot(gitTreeSource(root, configurationCommit), options) };
}

export function buildRegistryFromDirectory(root: string, options: BuildRegistryOptions = {}): RegistrySnapshot {
  return buildRegistrySnapshot(fsTreeSource(root), options);
}

export function writeRegistryFile(root: string, snapshot: RegistrySnapshot): string {
  const target = join(root, ...REGISTRY_FILE.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, skills: snapshot.skills, agents: snapshot.agents }, null, 2)}\n`);
  return REGISTRY_FILE;
}

export function materializeRegistry(root: string, provenance?: Map<string, SkillSource>): RegistrySnapshot {
  const snapshot = buildRegistryFromDirectory(root, { provenance });
  writeRegistryFile(root, snapshot);
  return snapshot;
}

export type { AgentConfig, SkillRecord };
