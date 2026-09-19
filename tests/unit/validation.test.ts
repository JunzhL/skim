import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, SkillRecord } from "@/lib/contracts";
import {
  conflictAnalysisRequests,
  conflictCandidateSchema,
  globsOverlap,
  normalizeScopes,
  structuralErrorSchema,
  validateSkillSet,
} from "@/lib/validation";

const hash = "c".repeat(64);

function record(overrides: Partial<SkillRecord> & { id: string }): SkillRecord {
  const { id } = overrides;
  return {
    name: id,
    description: id,
    path: `skills/${id}`,
    source: { type: "builtin", name: id },
    files: [{ path: "SKILL.md", hash }],
    scopes: { tasks: [], fileGlobs: [] },
    enabled: true,
    ...overrides,
  };
}

function agent(id: string, skillIds: string[]): AgentConfig {
  return { id, name: id, skills: skillIds.map((skillId) => ({ skillId, enabled: true, priority: 100 })) };
}

function codes(errors: { code: string }[]): string[] {
  return [...new Set(errors.map((error) => error.code))].sort();
}

describe("structural validation", () => {
  it("accepts a clean skill set", () => {
    const result = validateSkillSet({ skills: [record({ id: "a" }), record({ id: "b" })], agents: [agent("builder", ["a"])] });
    expect(result.errors).toEqual([]);
  });

  it("detects duplicate skill identifiers", () => {
    const result = validateSkillSet({ skills: [record({ id: "a" }), record({ id: "a" })], agents: [] });
    expect(codes(result.errors)).toContain("DUPLICATE_SKILL_ID");
  });

  it("detects duplicate display names across different skills", () => {
    const result = validateSkillSet({
      skills: [record({ id: "a", name: "Package Policy" }), record({ id: "b", name: "  package policy  " })],
      agents: [],
    });
    const error = result.errors.find((candidate) => candidate.code === "DUPLICATE_SKILL_NAME");
    expect(error?.skillIds).toEqual(["a", "b"]);
  });

  it("detects duplicate target paths", () => {
    const result = validateSkillSet({ skills: [record({ id: "a" }), record({ id: "b", path: "skills/a" })], agents: [] });
    expect(codes(result.errors)).toContain("DUPLICATE_SKILL_PATH");
  });

  it("detects duplicate file destinations from nested skill directories", () => {
    const result = validateSkillSet({
      skills: [record({ id: "a", files: [{ path: "b/SKILL.md", hash }] }), record({ id: "b", path: "skills/a/b" })],
      agents: [],
    });
    const error = result.errors.find((candidate) => candidate.code === "DUPLICATE_FILE_DESTINATION");
    expect(error?.details).toEqual({ destination: "skills/a/b/SKILL.md" });
    expect(error?.skillIds).toEqual(["a", "b"]);
  });

  it("detects missing dependencies", () => {
    const result = validateSkillSet({ skills: [record({ id: "a", dependencies: ["missing-skill"] })], agents: [] });
    const error = result.errors.find((candidate) => candidate.code === "MISSING_DEPENDENCY");
    expect(error?.details).toEqual({ dependency: "missing-skill" });
    expect(validateSkillSet({ skills: [record({ id: "a", dependencies: ["b"] }), record({ id: "b" })], agents: [] }).errors).toEqual([]);
  });

  it("detects assignments to skills that are not installed", () => {
    const result = validateSkillSet({ skills: [record({ id: "a" })], agents: [agent("builder", ["a", "ghost"])] });
    const error = result.errors.find((candidate) => candidate.code === "UNKNOWN_ASSIGNMENT");
    expect(error?.skillIds).toEqual(["ghost"]);
    expect(error?.details).toEqual({ agentId: "builder" });
  });

  it.each([
    ["a schema violation", record({ id: "a", files: [] })],
    ["a path that does not match the identifier", record({ id: "a", path: "skills/elsewhere" })],
    ["a self-dependency", record({ id: "a", dependencies: ["a"] })],
  ])("reports invalid metadata for %s", (_label, skill) => {
    expect(codes(validateSkillSet({ skills: [skill], agents: [] }).errors)).toContain("INVALID_METADATA");
  });

  it("returns machine-readable records in a stable order", () => {
    const input = {
      skills: [record({ id: "b", dependencies: ["nope"] }), record({ id: "a", path: "skills/wrong" }), record({ id: "a" })],
      agents: [agent("builder", ["ghost"])],
    };
    const first = validateSkillSet(input);
    const second = validateSkillSet(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const error of first.errors) expect(structuralErrorSchema.safeParse(error).success).toBe(true);
  });
});

describe("scope normalization", () => {
  it("trims, lowercases, deduplicates, and sorts declared scopes", () => {
    expect(normalizeScopes({ tasks: [" Build ", "build", "audit"], fileGlobs: ["./src//a.ts", "/src/a.ts", "b.ts"] })).toEqual({
      tasks: ["audit", "build"],
      fileGlobs: ["b.ts", "src/a.ts"],
    });
  });

  it.each([
    ["identical globs", "package.json", "package.json", true],
    ["a wildcard matching a literal", "*.json", "package.json", true],
    ["a literal matched by a wildcard", "package.json", "*.json", true],
    ["a ** prefix matching zero directories", "**/package.json", "package.json", true],
    ["a ** prefix matching nested directories", "**/package.json", "apps/web/package.json", true],
    ["disjoint extensions", "*.json", "*.yaml", false],
    ["a single star that does not cross directories", "*.json", "apps/package.json", false],
    ["unrelated literals", "package.json", "pnpm-lock.yaml", false],
  ])("resolves %s", (_label, a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
    expect(globsOverlap(b, a)).toBe(expected);
  });
});

describe("conflict candidates", () => {
  const pnpm = record({
    id: "package-manager-policy",
    scopes: { tasks: ["dependency-management"], fileGlobs: ["package.json", "pnpm-lock.yaml"] },
  });
  const npm = record({
    id: "npm-workflow",
    enabled: false,
    scopes: { tasks: ["dependency-management"], fileGlobs: ["package.json", "package-lock.json"] },
  });
  const art = record({ id: "algorithmic-art", scopes: { tasks: [], fileGlobs: [] } });

  it("pairs skills that share a task scope and a file scope", () => {
    const result = validateSkillSet({ skills: [pnpm, art], agents: [], incoming: npm });
    expect(result.candidates).toEqual([
      {
        skillAId: "npm-workflow",
        skillBId: "package-manager-policy",
        reason: "task-and-file-scope",
        sharedTasks: ["dependency-management"],
        sharedFileGlobs: [{ a: "package.json", b: "package.json" }],
      },
    ]);
    for (const candidate of result.candidates) expect(conflictCandidateSchema.safeParse(candidate).success).toBe(true);
  });

  it("does not make the pinned algorithmic-art fixture a package-manager candidate", () => {
    const result = validateSkillSet({ skills: [pnpm, record({ ...art, enabled: true })], agents: [], incoming: npm });
    expect(result.candidates.flatMap((candidate) => [candidate.skillAId, candidate.skillBId])).not.toContain("algorithmic-art");
  });

  it("produces no request for disjoint scopes", () => {
    const adapter = vi.fn();
    const result = validateSkillSet({
      skills: [record({ id: "a", scopes: { tasks: ["build"], fileGlobs: ["src/**"] } })],
      agents: [],
      incoming: record({ id: "b", enabled: false, scopes: { tasks: ["release"], fileGlobs: ["docs/**"] } }),
    });
    expect(result.candidates).toEqual([]);
    conflictAnalysisRequests(result).forEach(adapter);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("stops before any model adapter when a structural error exists", () => {
    const adapter = vi.fn();
    const result = validateSkillSet({ skills: [pnpm, record({ ...npm, enabled: true, path: "skills/package-manager-policy" })], agents: [] });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(conflictAnalysisRequests(result)).toEqual([]);
    conflictAnalysisRequests(result).forEach(adapter);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("hands the analyzer both skill records when nothing blocks", () => {
    const requests = conflictAnalysisRequests(validateSkillSet({ skills: [pnpm], agents: [], incoming: npm }));
    expect(requests).toHaveLength(1);
    expect(requests[0].skillA.id).toBe("npm-workflow");
    expect(requests[0].skillB.id).toBe("package-manager-policy");
  });

  it("ignores paused skills that are not the incoming skill", () => {
    const paused = record({ ...npm, id: "paused-workflow", enabled: false });
    expect(validateSkillSet({ skills: [pnpm, paused], agents: [] }).candidates).toEqual([]);
  });

  it("orders candidates deterministically", () => {
    const input = {
      skills: [
        record({ id: "zeta", scopes: { tasks: ["dependency-management"], fileGlobs: [] } }),
        record({ id: "alpha", scopes: { tasks: ["dependency-management"], fileGlobs: [] } }),
        pnpm,
      ],
      agents: [],
    };
    expect(validateSkillSet(input).candidates.map((candidate) => [candidate.skillAId, candidate.skillBId])).toEqual([
      ["alpha", "package-manager-policy"],
      ["alpha", "zeta"],
      ["package-manager-policy", "zeta"],
    ]);
    expect(JSON.stringify(validateSkillSet(input))).toBe(JSON.stringify(validateSkillSet(input)));
  });
});
