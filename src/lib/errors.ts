import type { ApiError } from "./contracts/common.ts";

export type SkimErrorCode =
  | "INVALID_SOURCE"
  | "COMMIT_NOT_FOUND"
  | "SUBDIRECTORY_NOT_FOUND"
  | "PATH_TRAVERSAL"
  | "UNSAFE_SYMLINK"
  | "UNSUPPORTED_ENTRY"
  | "NESTED_GIT_DIRECTORY"
  | "SKILL_TOO_LARGE"
  | "MISSING_SKILL_FILE"
  | "INVALID_FRONTMATTER"
  | "DESTINATION_EXISTS"
  | "NOT_A_GIT_REPOSITORY"
  | "EMPTY_HISTORY"
  | "MISSING_AGENTS_FILE"
  | "INVALID_AGENTS_FILE"
  | "INVALID_REGISTRY_FILE"
  | "INVALID_CATALOG_FILE"
  | "MODEL_PROVIDER_CREDENTIALS_MISSING"
  | "MODEL_PROVIDER_TIMEOUT"
  | "MODEL_PROVIDER_TRANSPORT_ERROR"
  | "MODEL_PROVIDER_REFUSAL"
  | "MODEL_PROVIDER_EMPTY_RESPONSE"
  | "MODEL_PROVIDER_MALFORMED_RESPONSE"
  | "MODEL_PROVIDER_SCHEMA_MISMATCH"
  | "INVALID_CONFLICT_CITATION"
  | "MANAGED_REPOSITORY_DIRTY"
  | "VALIDATION_FAILED"
  | "PREVIEW_NOT_FOUND"
  | "PREVIEW_REPOSITORY_MISMATCH"
  | "PREVIEW_STALE"
  | "PREVIEW_SOURCE_CHANGED"
  | "TRANSACTION_NOT_FOUND"
  | "TRANSACTION_INVALID"
  | "TRANSACTION_ALREADY_UNDONE"
  | "UNDO_STALE"
  | "GIT_FAILED";

export class SkimError extends Error {
  readonly code: SkimErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SkimErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SkimError";
    this.code = code;
    this.details = details;
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isSkimError(error: unknown, code?: SkimErrorCode): error is SkimError {
  return error instanceof SkimError && (code === undefined || error.code === code);
}
