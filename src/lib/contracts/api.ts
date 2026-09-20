import { z } from "zod";
import { apiErrorSchema, commitSchema, identifierSchema, relativePosixPathSchema, sha256Schema } from "./common";
import {
  agentConfigSchema,
  agentRunSchema,
  gitProvenanceSchema,
  installPreviewSchema,
  installTransactionRecordSchema,
  previewResolutionSchema,
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

export const gitImportSourceSchema = gitProvenanceSchema
  .pick({
    type: true,
    url: true,
    commit: true,
    subdirectory: true,
  })
  .extend({
    url: z.string().url().refine((value) => new URL(value).protocol === "https:", {
      message: "Git import URL must use HTTPS",
    }),
  });
export const catalogEntrySchema = z.object({
  id: identifierSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  source: gitImportSourceSchema,
  license: z.string().min(1),
  tags: z.array(identifierSchema),
});

export const getCatalogResponseSchema = z.object({ entries: z.array(catalogEntrySchema) });

export const browseCatalogRequestSchema = z.object({
  url: gitImportSourceSchema.shape.url,
  commit: gitImportSourceSchema.shape.commit,
});

export const browsedSkillSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  subdirectory: relativePosixPathSchema,
  license: z.string().min(1),
  fileCount: z.number().int().min(1),
});

export const browseCatalogResponseSchema = z.object({
  url: gitImportSourceSchema.shape.url,
  commit: gitImportSourceSchema.shape.commit,
  skills: z.array(browsedSkillSchema),
});

export const importPreviewRequestSchema = z.object({ source: gitImportSourceSchema });
export const importPreviewResponseSchema = installPreviewSchema;

export const installTransactionRequestSchema = z.object({
  previewId: identifierSchema,
  resolution: previewResolutionSchema,
});
export const cancelledInstallResponseSchema = z.object({
  type: z.literal("cancelled"),
  previewId: identifierSchema,
  transactionId: identifierSchema,
});
export const installTransactionResponseSchema = z.union([
  installTransactionRecordSchema,
  cancelledInstallResponseSchema,
]);

export const undoConflictFileSchema = z.object({
  path: relativePosixPathSchema,
  beforeHash: sha256Schema.nullable(),
  expectedAfterHash: sha256Schema.nullable(),
  currentHash: sha256Schema.nullable(),
  beforeMode: z.string().regex(/^[0-7]{6}$/).nullable(),
  expectedAfterMode: z.string().regex(/^[0-7]{6}$/).nullable(),
  currentMode: z.string().regex(/^[0-7]{6}$/).nullable(),
  before: z.string().nullable(),
  expectedAfter: z.string().nullable(),
  current: z.string().nullable(),
  threeWayDiff: z.string().min(1),
});

export const undoConflictSchema = z.object({
  type: z.literal("conflict"),
  transactionId: identifierSchema,
  message: z.string().min(1),
  paths: z.array(relativePosixPathSchema).min(1),
  files: z.array(undoConflictFileSchema).min(1),
});
export const undoTransactionResponseSchema = z.union([
  z.object({ type: z.literal("committed"), transaction: undoTransactionRecordSchema }),
  undoConflictSchema,
]);

export const agentStatusResponseSchema = z.object({
  agentId: identifierSchema,
  name: z.string().min(1),
  loadedConfigurationCommit: commitSchema.nullable(),
  activeSkillIds: z.array(identifierSchema),
});
export const agentReloadResponseSchema = z.object({ agentId: identifierSchema, loadedConfigurationCommit: commitSchema });
export const agentRunRequestSchema = z.object({ task: z.string().min(1) });
export const agentRunResponseSchema = agentRunSchema;

export const reservedApiSchema = {
  "GET /api/registry": { response: getRegistryResponseSchema, error: apiErrorSchema },
  "GET /api/catalog": { response: getCatalogResponseSchema, error: apiErrorSchema },
  "POST /api/catalog/browse": { request: browseCatalogRequestSchema, response: browseCatalogResponseSchema, error: apiErrorSchema },
  "GET /api/transactions": { response: getTransactionsResponseSchema, error: apiErrorSchema },
  "POST /api/imports/preview": { request: importPreviewRequestSchema, response: importPreviewResponseSchema, error: apiErrorSchema },
  "POST /api/transactions/install": { request: installTransactionRequestSchema, response: installTransactionResponseSchema, error: apiErrorSchema },
  "POST /api/transactions/:id/undo": { response: undoTransactionResponseSchema, error: apiErrorSchema },
  "GET /api/agents/:id": { response: agentStatusResponseSchema, error: apiErrorSchema },
  "POST /api/agents/:id/reload": { response: agentReloadResponseSchema, error: apiErrorSchema },
  "POST /api/agents/:id/run": { request: agentRunRequestSchema, response: agentRunResponseSchema, error: apiErrorSchema },
} as const;

export type UndoConflictFile = z.infer<typeof undoConflictFileSchema>;
export type UndoConflict = z.infer<typeof undoConflictSchema>;

export type GitImportSource = z.infer<typeof gitImportSourceSchema>;
export type CancelledInstallResponse = z.infer<typeof cancelledInstallResponseSchema>;

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;
export type BrowsedSkill = z.infer<typeof browsedSkillSchema>;
export type BrowseCatalogResponse = z.infer<typeof browseCatalogResponseSchema>;
export type GetCatalogResponse = z.infer<typeof getCatalogResponseSchema>;
