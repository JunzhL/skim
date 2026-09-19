import { z } from "zod";
import { identifierSchema, skillRecordSchema, type AgentConfig, type SkillRecord } from "../contracts";
import { normalizeScopes, scopeOverlap } from "./scopes";

export { globsOverlap, normalizeScopes, scopeOverlap } from "./scopes";
export type { NormalizedScopes, ScopeOverlap } from "./scopes";

export const structuralErrorSchema = z.object({
  code: z.enum([
    "DUPLICATE_SKILL_ID",
    "DUPLICATE_SKILL_NAME",
    "DUPLICATE_SKILL_PATH",
    "DUPLICATE_FILE_DESTINATION",
    "MISSING_DEPENDENCY",
    "UNKNOWN_ASSIGNMENT",
    "INVALID_METADATA",
  ]),
  message: z.string().min(1),
  skillIds: z.array(z.string().min(1)),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const conflictCandidateSchema = z.object({
  skillAId: identifierSchema,
  skillBId: identifierSchema,
  reason: z.enum(["task-scope", "file-scope", "task-and-file-scope"]),
  sharedTasks: z.array(z.string().min(1)),
  sharedFileGlobs: z.array(z.object({ a: z.string().min(1), b: z.string().min(1) })),
});

export type StructuralError = z.infer<typeof structuralErrorSchema>;
export type ConflictCandidate = z.infer<typeof conflictCandidateSchema>;

export type ValidationInput = {
  skills: SkillRecord[];
  agents: AgentConfig[];
  incoming?: SkillRecord;
};

export type ValidationResult = {
  errors: StructuralError[];
  candidates: ConflictCandidate[];
  analyzed: SkillRecord[];
};

export type ConflictAnalysisRequest = {
  candidate: ConflictCandidate;
  skillA: SkillRecord;
  skillB: SkillRecord;
};

function compareErrors(a: StructuralError, b: StructuralError): number {
  const key = (error: StructuralError) => `${error.code}\u0000${error.skillIds.join(",")}\u0000${error.message}`;
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

function groupDuplicates(records: SkillRecord[], keyOf: (skill: SkillRecord) => string | undefined): Map<string, SkillRecord[]> {
  const groups = new Map<string, SkillRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    if (key === undefined) continue;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return new Map([...groups].filter(([, group]) => group.length > 1));
}

function metadataErrors(records: SkillRecord[]): StructuralError[] {
  const errors: StructuralError[] = [];
  for (const record of records) {
    const parsed = skillRecordSchema.safeParse(record);
    if (!parsed.success) {
      errors.push({
        code: "INVALID_METADATA",
        message: `Skill ${record.id} has invalid metadata`,
        skillIds: [record.id],
        details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) },
      });
      continue;
    }
    if (!record.path.endsWith(`/${record.id}`) && record.path !== record.id) {
      errors.push({
        code: "INVALID_METADATA",
        message: `Skill ${record.id} is installed at ${record.path}, which does not match its identifier`,
        skillIds: [record.id],
        details: { path: record.path },
      });
    }
    if (record.dependencies?.includes(record.id)) {
      errors.push({
        code: "INVALID_METADATA",
        message: `Skill ${record.id} declares itself as a dependency`,
        skillIds: [record.id],
      });
    }
  }
  return errors;
}

function duplicateErrors(records: SkillRecord[]): StructuralError[] {
  const errors: StructuralError[] = [];

  for (const [id, group] of groupDuplicates(records, (skill) => skill.id)) {
    errors.push({
      code: "DUPLICATE_SKILL_ID",
      message: `Skill identifier ${id} is declared ${group.length} times`,
      skillIds: [id],
    });
  }

  for (const [, group] of groupDuplicates(records, (skill) => skill.name.trim().toLowerCase())) {
    const ids = [...new Set(group.map((skill) => skill.id))].sort();
    if (ids.length < 2) continue;
    errors.push({
      code: "DUPLICATE_SKILL_NAME",
      message: `Skills ${ids.join(" and ")} share the display name ${group[0].name}`,
      skillIds: ids,
      details: { name: group[0].name },
    });
  }

  for (const [path, group] of groupDuplicates(records, (skill) => skill.path)) {
    errors.push({
      code: "DUPLICATE_SKILL_PATH",
      message: `Skills ${[...new Set(group.map((skill) => skill.id))].sort().join(" and ")} target ${path}`,
      skillIds: [...new Set(group.map((skill) => skill.id))].sort(),
      details: { path },
    });
  }

  const destinations = new Map<string, Set<string>>();
  for (const record of records) {
    for (const file of record.files) {
      const destination = `${record.path}/${file.path}`;
      destinations.set(destination, (destinations.get(destination) ?? new Set()).add(record.id));
    }
  }
  for (const [destination, owners] of destinations) {
    if (owners.size < 2) continue;
    errors.push({
      code: "DUPLICATE_FILE_DESTINATION",
      message: `Skills ${[...owners].sort().join(" and ")} both write ${destination}`,
      skillIds: [...owners].sort(),
      details: { destination },
    });
  }

  return errors;
}

function dependencyErrors(records: SkillRecord[], agents: AgentConfig[]): StructuralError[] {
  const errors: StructuralError[] = [];
  const known = new Set(records.map((skill) => skill.id));

  for (const record of records) {
    for (const dependency of record.dependencies ?? []) {
      if (dependency === record.id || known.has(dependency)) continue;
      errors.push({
        code: "MISSING_DEPENDENCY",
        message: `Skill ${record.id} depends on ${dependency}, which is not installed`,
        skillIds: [record.id],
        details: { dependency },
      });
    }
  }

  for (const agent of agents) {
    for (const assignment of agent.skills) {
      if (known.has(assignment.skillId)) continue;
      errors.push({
        code: "UNKNOWN_ASSIGNMENT",
        message: `Agent ${agent.id} is assigned ${assignment.skillId}, which is not installed`,
        skillIds: [assignment.skillId],
        details: { agentId: agent.id },
      });
    }
  }

  return errors;
}

export function validateSkillSet(input: ValidationInput): ValidationResult {
  const records = input.incoming ? [...input.skills, input.incoming] : [...input.skills];
  const errors = [...metadataErrors(records), ...duplicateErrors(records), ...dependencyErrors(records, input.agents)].sort(compareErrors);

  const analyzed = [...records.filter((skill) => skill.enabled), ...(input.incoming && !input.incoming.enabled ? [input.incoming] : [])]
    .filter((skill, index, all) => all.findIndex((other) => other.id === skill.id) === index)
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const candidates: ConflictCandidate[] = [];
  for (let i = 0; i < analyzed.length; i += 1) {
    for (let j = i + 1; j < analyzed.length; j += 1) {
      const overlap = scopeOverlap(normalizeScopes(analyzed[i].scopes), normalizeScopes(analyzed[j].scopes));
      if (overlap.tasks.length === 0 && overlap.fileGlobs.length === 0) continue;
      candidates.push({
        skillAId: analyzed[i].id,
        skillBId: analyzed[j].id,
        reason:
          overlap.tasks.length > 0 && overlap.fileGlobs.length > 0
            ? "task-and-file-scope"
            : overlap.tasks.length > 0
              ? "task-scope"
              : "file-scope",
        sharedTasks: overlap.tasks,
        sharedFileGlobs: overlap.fileGlobs,
      });
    }
  }

  return { errors, candidates, analyzed };
}

export function conflictAnalysisRequests(result: ValidationResult): ConflictAnalysisRequest[] {
  if (result.errors.length > 0) return [];
  return result.candidates.map((candidate) => ({
    candidate,
    skillA: result.analyzed.find((skill) => skill.id === candidate.skillAId)!,
    skillB: result.analyzed.find((skill) => skill.id === candidate.skillBId)!,
  }));
}
