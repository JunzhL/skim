import {
  installTransactionRequestSchema,
  installTransactionResponseSchema,
} from "@/lib/contracts";
import { validateRuntimeConfig } from "@/lib/runtime-config";
import { confirmInstall } from "@/lib/transactions";
import { transactionErrorResponse } from "../../transaction-error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = installTransactionRequestSchema.parse(await request.json());
    const config = validateRuntimeConfig(process.env);
    const result = await confirmInstall({
      repoPath: config.repoPath,
      previewId: body.previewId,
      resolution: body.resolution,
    });
    return Response.json(installTransactionResponseSchema.parse(result));
  } catch (error) {
    return transactionErrorResponse(error);
  }
}
