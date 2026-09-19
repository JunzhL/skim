import { createConfiguredConflictAdapter } from "@/lib/conflicts";
import {
  importPreviewRequestSchema,
  importPreviewResponseSchema,
} from "@/lib/contracts";
import { validateRuntimeConfig } from "@/lib/runtime-config";
import { createInstallPreview } from "@/lib/transactions";
import { transactionErrorResponse } from "../../transaction-error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = importPreviewRequestSchema.parse(await request.json());
    const config = validateRuntimeConfig(process.env);
    const preview = await createInstallPreview({
      repoPath: config.repoPath,
      source: body.source,
      createConflictAdapter: () => createConfiguredConflictAdapter(config),
    });
    return Response.json(importPreviewResponseSchema.parse(preview));
  } catch (error) {
    return transactionErrorResponse(error);
  }
}
