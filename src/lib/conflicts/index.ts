import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import {
  conflictReportSchema,
  identifierSchema,
  relativePosixPathSchema,
  type ConflictReport,
  type SkillRecord,
} from "../contracts";
import { SkimError } from "../errors";
import type { ConflictAnalysisRequest } from "../validation";
import type { ConflictModelAdapter } from "./providers";

export * from "./providers";

const modelConflictEvidenceSchema = z
  .object({
    skillId: identifierSchema,
    filePath: relativePosixPathSchema,
    lineStart: z.number().int().min(1),
    lineEnd: z.number().int().min(1),
    quote: z.string().min(1),
  })
  .strict()
  .refine((value) => value.lineEnd >= value.lineStart, {
    message: "lineEnd must be >= lineStart",
    path: ["lineEnd"],
  });

const modelConflictOutputSchema = z
  .object({
    commonScenario: z.string().min(1),
    confidence: z.number().min(0).max(1),
    explanation: z.string().min(1),
    evidence: z.array(modelConflictEvidenceSchema).min(2),
  })
  .strict();

export type ConflictContentSource = {
  read(skill: SkillRecord, filePath: string): Buffer;
};

export type AnalyzeConflictOptions = {
  adapter: ConflictModelAdapter;
  source: ConflictContentSource;
};

function staysInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function directoryConflictSource(rootInput: string): ConflictContentSource {
  const root = realpathSync(resolve(rootInput));
  return {
    read(skill, filePath) {
      relativePosixPathSchema.parse(skill.path);
      relativePosixPathSchema.parse(filePath);
      const skillRoot = realpathSync(resolve(root, ...skill.path.split("/")));
      if (!staysInside(skillRoot, root)) {
        throw new SkimError(
          "INVALID_CONFLICT_CITATION",
          `Skill ${skill.id} resolves outside the conflict-analysis root`,
          { skillId: skill.id, skillPath: skill.path },
        );
      }
      const requested = resolve(skillRoot, ...filePath.split("/"));
      if (!staysInside(requested, skillRoot)) {
        throw new SkimError(
          "INVALID_CONFLICT_CITATION",
          `Conflict evidence path escapes skill ${skill.id}`,
          { skillId: skill.id, filePath },
        );
      }
      const target = realpathSync(requested);
      if (!staysInside(target, skillRoot)) {
        throw new SkimError(
          "INVALID_CONFLICT_CITATION",
          `Conflict evidence resolves outside skill ${skill.id}`,
          { skillId: skill.id, filePath },
        );
      }
      return readFileSync(target);
    },
  };
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function lineNumbered(value: string): string {
  return normalizeNewlines(value)
    .split("\n")
    .map((line, index) => `${index + 1} | ${line}`)
    .join("\n");
}

function skillMaterial(skill: SkillRecord, source: ConflictContentSource): string {
  return skill.files
    .map((file) => {
      const content = source.read(skill, file.path).toString("utf8");
      return [`FILE ${file.path}`, lineNumbered(content)].join("\n");
    })
    .join("\n\n");
}

export function buildConflictPrompt(
  request: ConflictAnalysisRequest,
  source: ConflictContentSource,
): string {
  return [
    "Determine whether these two agent skills contain contradictory instructions in the candidate's shared scope.",
    "Return JSON only. The JSON object must have exactly these fields:",
    '{"commonScenario":"string","confidence":0.0,"explanation":"string","evidence":[{"skillId":"string","filePath":"relative/path","lineStart":1,"lineEnd":1,"quote":"exact source substring"}]}',
    "Evidence must cite exact substrings from the provided files with 1-based inclusive line ranges.",
    "Include evidence from both skills. Do not recommend a resolution or choose a winner.",
    "",
    `CANDIDATE ${JSON.stringify(request.candidate)}`,
    "",
    `BEGIN SKILL ${request.skillA.id}`,
    skillMaterial(request.skillA, source),
    `END SKILL ${request.skillA.id}`,
    "",
    `BEGIN SKILL ${request.skillB.id}`,
    skillMaterial(request.skillB, source),
    `END SKILL ${request.skillB.id}`,
  ].join("\n");
}

function invalidCitation(message: string, details: Record<string, unknown>): never {
  throw new SkimError("INVALID_CONFLICT_CITATION", message, details);
}

export function verifyConflictEvidence(
  report: ConflictReport,
  request: ConflictAnalysisRequest,
  source: ConflictContentSource,
): void {
  const skills = new Map([
    [request.skillA.id, request.skillA],
    [request.skillB.id, request.skillB],
  ]);
  const seen = new Set<string>();

  for (const evidence of report.evidence) {
    const skill = skills.get(evidence.skillId);
    if (!skill) {
      invalidCitation(
        `Conflict evidence references skill ${evidence.skillId} outside the candidate`,
        { skillId: evidence.skillId, candidate: request.candidate },
      );
    }
    if (!skill.files.some((file) => file.path === evidence.filePath)) {
      invalidCitation(
        `Conflict evidence references ${evidence.filePath}, which is not a file of skill ${skill.id}`,
        { skillId: skill.id, filePath: evidence.filePath },
      );
    }

    const text = normalizeNewlines(source.read(skill, evidence.filePath).toString("utf8"));
    const lines = text.split("\n");
    if (evidence.lineEnd > lines.length) {
      invalidCitation(
        `Conflict evidence line range exceeds ${evidence.filePath}`,
        { skillId: skill.id, filePath: evidence.filePath, lineStart: evidence.lineStart, lineEnd: evidence.lineEnd },
      );
    }

    const selected = lines.slice(evidence.lineStart - 1, evidence.lineEnd).join("\n");
    const quote = normalizeNewlines(evidence.quote);
    if (!selected.includes(quote)) {
      invalidCitation(
        `Conflict evidence quote does not match ${evidence.filePath}:${evidence.lineStart}-${evidence.lineEnd}`,
        { skillId: skill.id, filePath: evidence.filePath, quote: evidence.quote },
      );
    }
    seen.add(skill.id);
  }

  for (const skill of [request.skillA, request.skillB]) {
    if (!seen.has(skill.id)) {
      invalidCitation(
        `Conflict report must cite skill ${skill.id}`,
        { skillId: skill.id },
      );
    }
  }
}

export async function analyzeConflict(
  request: ConflictAnalysisRequest,
  options: AnalyzeConflictOptions,
): Promise<ConflictReport> {
  if (request.skillA.id !== request.candidate.skillAId || request.skillB.id !== request.candidate.skillBId) {
    throw new SkimError(
      "MODEL_PROVIDER_SCHEMA_MISMATCH",
      "Conflict-analysis request skill ids do not match its candidate",
      {
        candidate: request.candidate,
        skillAId: request.skillA.id,
        skillBId: request.skillB.id,
      },
    );
  }

  const raw = await options.adapter.analyze({
    prompt: buildConflictPrompt(request, options.source),
  });
  const parsed = modelConflictOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SkimError(
      "MODEL_PROVIDER_SCHEMA_MISMATCH",
      `${options.adapter.provider} returned a conflict report that does not match the application schema`,
      {
        provider: options.adapter.provider,
        model: options.adapter.model,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    );
  }

  const report = conflictReportSchema.parse({
    skillAId: request.skillA.id,
    skillBId: request.skillB.id,
    analysis: {
      provider: options.adapter.provider,
      model: options.adapter.model,
    },
    ...parsed.data,
  });

  verifyConflictEvidence(report, request, options.source);
  return report;
}
