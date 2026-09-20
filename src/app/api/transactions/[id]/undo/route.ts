import { undoTransactionResponseSchema } from "@/lib/contracts";
import { undoInstallTransaction } from "@/lib/transactions/undo";
import { validateRuntimeConfig } from "@/lib/runtime-config";
import { transactionErrorResponse } from "../../../transaction-error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    const { repoPath } = validateRuntimeConfig(process.env);
    const result = await undoInstallTransaction({ repoPath, transactionId: id });
    return Response.json(undoTransactionResponseSchema.parse(result));
  } catch (error) {
    return transactionErrorResponse(error);
  }
}
