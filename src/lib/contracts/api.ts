import { z } from "zod";
import { apiErrorSchema, commitSchema, identifierSchema, relativePosixPathSchema } from "./common";
import {
  agentConfigSchema,
  agentRunSchema,
  gitProvenanceSchema,
  installPreviewSchema,
  installResolutionSchema,
  installTransactionRecordSchema,
  skillRecordSchema,
  transactionRecordSchema,
  undoTransactionRecordSchema,
} from "./domain";

export const getRegistryResponseSchema = z.object({
  configurationCommit: commitSchema,
  skills: z.array(skillRecordSchema),
  agents: z.array(agentConfigSchema),
});

export const getTransactionsResponseSchema = z.object({ transactions: z.array(transactionRecordSchema) });

export const importPreviewRequestSchema = z.object({ source: gitProvenanceSchema });
export const importPreviewResponseSchema = installPreviewSchema;

export const installTransactionRequestSchema = z.object({
  previewId: identifierSchema,
  resolution: installResolutionSchema,
});
export const installTransactionResponseSchema = installTransactionRecordSchema;

export const undoConflictSchema = z.object({
  type: z.literal("conflict"),
  transactionId: identifierSchema,
  message: z.string().min(1),
  paths: z.array(relativePosixPathSchema).min(1),
});
export const undoTransactionResponseSchema = z.union([
  z.object({ type: z.literal("committed"), transaction: undoTransactionRecordSchema }),
  undoConflictSchema,
]);

export const agentReloadResponseSchema = z.object({ agentId: identifierSchema, loadedConfigurationCommit: commitSchema });
export const agentRunRequestSchema = z.object({ task: z.string().min(1) });
export const agentRunResponseSchema = agentRunSchema;

export const reservedApiSchema = {
  "GET /api/registry": { response: getRegistryResponseSchema, error: apiErrorSchema },
  "GET /api/transactions": { response: getTransactionsResponseSchema, error: apiErrorSchema },
  "POST /api/imports/preview": { request: importPreviewRequestSchema, response: importPreviewResponseSchema, error: apiErrorSchema },
  "POST /api/transactions/install": { request: installTransactionRequestSchema, response: installTransactionResponseSchema, error: apiErrorSchema },
  "POST /api/transactions/:id/undo": { response: undoTransactionResponseSchema, error: apiErrorSchema },
  "POST /api/agents/:id/reload": { response: agentReloadResponseSchema, error: apiErrorSchema },
  "POST /api/agents/:id/run": { request: agentRunRequestSchema, response: agentRunResponseSchema, error: apiErrorSchema },
} as const;

export type UndoConflict = z.infer<typeof undoConflictSchema>;
