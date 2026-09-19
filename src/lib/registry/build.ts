import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { agentConfigSchema, agentsFileSchema, skillRecordSchema, type AgentConfig, type SkillRecord } from "../contracts";
import { SkimError } from "../errors";
import { parseSkillFrontmatter } from "../skills/frontmatter";
import type { TreeSource } from "./tree-source";

export const REGISTRY_FILE = ".skim/registry.json";
export const AGENTS_FILE = "agents.yaml";
export const SKILLS_DIRECTORY = "skills";

export const registryFileSchema = z.object({
  schemaVersion: z.literal(1),
  skills: z.array(skillRecordSchema),
  agents: z.array(agentConfigSchema),
});

export type RegistryFile = z.infer<typeof registryFileSchema>;
export type RegistrySnapshot = { skills: SkillRecord[]; agents: AgentConfig[] };
export type SkillSource = SkillRecord["source"];

export type BuildRegistryOptions = {
  skillsDirectory?: string;
  provenance?: Map<string, SkillSource>;
};

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readAgents(source: TreeSource): AgentConfig[] {
  if (!source.exists(AGENTS_FILE)) {
    throw new SkimError("MISSING_AGENTS_FILE", `${AGENTS_FILE} is missing from ${source.describe}`, { path: AGENTS_FILE });
  }

  let document: unknown;
  try {
    document = parseYaml(source.read(AGENTS_FILE).toString("utf8"));
  } catch (error) {
    throw new SkimError("INVALID_AGENTS_FILE", `${AGENTS_FILE} is not valid YAML`, {
      path: AGENTS_FILE,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = agentsFileSchema.safeParse(document);
  if (!parsed.success) {
    throw new SkimError("INVALID_AGENTS_FILE", `${AGENTS_FILE} does not match the agents schema`, {
      path: AGENTS_FILE,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data.agents;
}

function readLedger(source: TreeSource): Map<string, SkillSource> {
  if (!source.exists(REGISTRY_FILE)) return new Map();

  let document: unknown;
  try {
    document = JSON.parse(source.read(REGISTRY_FILE).toString("utf8"));
  } catch (error) {
    throw new SkimError("INVALID_REGISTRY_FILE", `${REGISTRY_FILE} is not valid JSON`, {
      path: REGISTRY_FILE,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const parsed = registryFileSchema.safeParse(document);
  if (!parsed.success) {
    throw new SkimError("INVALID_REGISTRY_FILE", `${REGISTRY_FILE} does not match the registry schema`, {
      path: REGISTRY_FILE,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return new Map(parsed.data.skills.map((skill) => [skill.id, skill.source]));
}

function displayName(slug: string, body: string): string {
  const heading = body.replace(/^```[\s\S]*?^```/gm, "").match(/^#[ \t]+(.+?)[ \t]*$/m);
  if (heading) return heading[1];
  return slug
    .split(/[-._]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function buildRegistrySnapshot(source: TreeSource, options: BuildRegistryOptions = {}): RegistrySnapshot {
  const skillsDirectory = options.skillsDirectory ?? SKILLS_DIRECTORY;
  const agents = readAgents(source);
  const ledger = readLedger(source);
  const enabledSkillIds = new Set(
    agents.flatMap((agent) => agent.skills.filter((assignment) => assignment.enabled).map((assignment) => assignment.skillId)),
  );

  const skills: SkillRecord[] = [];
  for (const slug of source.directories(skillsDirectory)) {
    if (slug.startsWith(".")) continue;
    const prefix = `${skillsDirectory}/${slug}`;
    if (!source.exists(`${prefix}/SKILL.md`)) continue;

    const content = source.read(`${prefix}/SKILL.md`).toString("utf8");
    const frontmatter = parseSkillFrontmatter(content, `${prefix}/SKILL.md`);
    const files = source
      .list(prefix)
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({ path: entry.path, hash: sha256(source.read(entry.fullPath)) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));

    skills.push({
      id: slug,
      name: displayName(slug, content),
      description: frontmatter.description,
      path: prefix,
      source: options.provenance?.get(slug) ?? ledger.get(slug) ?? { type: "builtin", name: slug },
      files,
      scopes: frontmatter.scopes,
      enabled: enabledSkillIds.has(slug),
    });
  }

  skills.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { skills, agents };
}
