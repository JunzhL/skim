import { ZodError } from "zod";
import { SkimError } from "@/lib/errors";

function skimStatus(error: SkimError): number {
  if (error.code === "MODEL_PROVIDER_CREDENTIALS_MISSING") return 503;
  if (error.code.startsWith("MODEL_PROVIDER_") || error.code === "INVALID_CONFLICT_CITATION") return 502;
  if (error.code === "PREVIEW_NOT_FOUND") return 404;
  if (
    error.code === "PREVIEW_STALE" ||
    error.code === "PREVIEW_REPOSITORY_MISMATCH" ||
    error.code === "PREVIEW_SOURCE_CHANGED" ||
    error.code === "MANAGED_REPOSITORY_DIRTY" ||
    error.code === "VALIDATION_FAILED" ||
    error.code === "DESTINATION_EXISTS"
  ) {
    return 409;
  }
  return 400;
}

export function transactionErrorResponse(error: unknown): Response {
  if (error instanceof ZodError) {
    return Response.json(
      {
        code: "INVALID_REQUEST",
        message: "Request body does not match the API contract",
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }
  if (error instanceof SyntaxError) {
    return Response.json(
      { code: "INVALID_JSON", message: "Request body is not valid JSON" },
      { status: 400 },
    );
  }
  if (error instanceof SkimError) {
    return Response.json(error.toApiError(), { status: skimStatus(error) });
  }
  return Response.json(
    {
      code: "TRANSACTION_UNAVAILABLE",
      message: error instanceof Error ? error.message : String(error),
    },
    { status: 500 },
  );
}
