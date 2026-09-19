import { z } from "zod";

export const identifierSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/);
export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const utcTimestampSchema = z.string().datetime({ offset: false });

export const relativePosixPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), "Path must be relative")
  .refine((value) => !value.includes("\\"), "Path must use POSIX separators")
  .refine((value) => value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Path must be normalized");

export const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
