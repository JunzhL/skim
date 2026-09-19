import { z } from "zod";
import { commitSchema, identifierSchema, relativePosixPathSchema, sha256Schema, utcTimestampSchema } from "./common";

const builtinSourceSchema = z.object({
  type: z.literal("builtin"),
  name: z.string().min(1),
});

export const gitProvenanceSchema = z.object({
  type: z.literal("git"),
  url: z.string().url(),
  commit: commitSchema,
  subdirectory: relativePosixPathSchema,
  license: z.string().min(1),
});

export const skillSourceSchema = z.discriminatedUnion("type", [builtinSourceSchema, gitProvenanceSchema]);

export const skillRecordSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1),
  description: z.string(),
  path: relativePosixPathSchema,
  source: skillSourceSchema,
  files: z.array(z.object({ path: relativePosixPathSchema, hash: sha256Schema })).min(1),
  scopes: z.object({
    tasks: z.array(identifierSchema),
    fileGlobs: z.array(z.string().min(1)),
  }),
  enabled: z.boolean(),
});

export const skillAssignmentSchema = z.object({
  skillId: identifierSchema,
  enabled: z.boolean(),
  priority: z.number().int(),
});

export const agentConfigSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1),
  skills: z.array(skillAssignmentSchema),
});

export const agentsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    agents: z.array(agentConfigSchema),
  })
  .superRefine(({ agents }, ctx) => {
    const ids = new Set<string>();
    for (const agent of agents) {
      if (ids.has(agent.id)) {
        ctx.addIssue({ code: "custom", path: ["agents"], message: `Duplicate agent id: ${agent.id}` });
      }
      ids.add(agent.id);
    }
  });

export const conflictEvidenceSchema = z.object({
  skillId: identifierSchema,
  filePath: relativePosixPathSchema,
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  quote: z.string().min(1),
}).refine((value) => value.lineEnd >= value.lineStart, { message: "lineEnd must be >= lineStart", path: ["lineEnd"] });

export const conflictReportSchema = z.object({
  skillAId: identifierSchema,
  skillBId: identifierSchema,
  commonScenario: z.string().min(1),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  evidence: z.array(conflictEvidenceSchema).min(2),
});

export const installResolutionSchema = z.enum(["keep-existing", "activate-incoming", "cancel"]);

export const installPreviewSchema = z.object({
  previewId: identifierSchema,
  baseCommit: commitSchema,
  incomingSkill: skillRecordSchema,
  unifiedDiff: z.string(),
  conflicts: z.array(conflictReportSchema),
  allowedResolutions: z.array(installResolutionSchema).min(1),
  createdAt: utcTimestampSchema,
});

export const transactionRecordSchema = z.object({
  transactionId: identifierSchema,
  type: z.enum(["install", "undo"]),
  resolution: installResolutionSchema,
  beforeCommit: commitSchema,
  afterCommit: commitSchema,
  affectedPathHashes: z.array(z.object({
    path: relativePosixPathSchema,
    beforeHash: sha256Schema.nullable(),
    afterHash: sha256Schema.nullable(),
  })),
  createdAt: utcTimestampSchema,
  originalTransactionId: identifierSchema.optional(),
});

export const agentRunSchema = z.object({
  runId: identifierSchema,
  agentId: identifierSchema,
  task: z.string().min(1),
  configurationCommit: commitSchema,
  interceptedExecutable: z.string().min(1),
  interceptedArguments: z.array(z.string()),
  expectedLockfile: relativePosixPathSchema,
  status: z.enum(["planned", "completed", "failed"]),
  timestamp: utcTimestampSchema,
});

export type GitProvenance = z.infer<typeof gitProvenanceSchema>;
export type SkillRecord = z.infer<typeof skillRecordSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentsFile = z.infer<typeof agentsFileSchema>;
export type ConflictReport = z.infer<typeof conflictReportSchema>;
export type InstallResolution = z.infer<typeof installResolutionSchema>;
export type InstallPreview = z.infer<typeof installPreviewSchema>;
export type TransactionRecord = z.infer<typeof transactionRecordSchema>;
export type AgentRun = z.infer<typeof agentRunSchema>;
