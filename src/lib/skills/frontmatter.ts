import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { identifierSchema, skillWorkflowSchema } from "../contracts";
import { SkimError } from "../errors";

const scopesSchema = z
  .object({
    tasks: z.array(identifierSchema).default([]),
    fileGlobs: z.array(z.string().min(1)).default([]),
  })
  .default({ tasks: [], fileGlobs: [] });

const frontmatterSchema = z.looseObject({
  name: identifierSchema,
  description: z.string().min(1),
  license: z.string().min(1).optional(),
  scopes: scopesSchema,
  dependencies: z.array(identifierSchema).default([]),
  workflows: z.array(skillWorkflowSchema).default([]),
});

export type SkillFrontmatter = z.infer<typeof frontmatterSchema>;

const DELIMITER = /^---[ \t]*\r?\n/;

export function parseSkillFrontmatter(content: string, filePath: string): SkillFrontmatter {
  const text = content.startsWith("﻿") ? content.slice(1) : content;
  if (!DELIMITER.test(text)) {
    throw new SkimError("INVALID_FRONTMATTER", `${filePath} must start with a YAML frontmatter block`, { filePath });
  }

  const body = text.replace(DELIMITER, "");
  const closing = body.search(/^---[ \t]*(\r?\n|$)/m);
  if (closing < 0) {
    throw new SkimError("INVALID_FRONTMATTER", `${filePath} has an unterminated frontmatter block`, { filePath });
  }

  let document: unknown;
  try {
    document = parseYaml(body.slice(0, closing));
  } catch (error) {
    throw new SkimError("INVALID_FRONTMATTER", `${filePath} has malformed YAML frontmatter`, {
      filePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new SkimError("INVALID_FRONTMATTER", `${filePath} frontmatter must be a YAML mapping`, { filePath });
  }

  const parsed = frontmatterSchema.safeParse(document);
  if (!parsed.success) {
    throw new SkimError("INVALID_FRONTMATTER", `${filePath} frontmatter is invalid`, {
      filePath,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}
