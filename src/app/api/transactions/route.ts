import { getTransactionsResponseSchema } from "@/lib/contracts";
import { listTransactionHistory } from "@/lib/transactions/history";
import { validateRuntimeConfig } from "@/lib/runtime-config";
import { transactionErrorResponse } from "../transaction-error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    const { repoPath } = validateRuntimeConfig(process.env);
    return Response.json(
      getTransactionsResponseSchema.parse({
        transactions: listTransactionHistory(repoPath),
      }),
    );
  } catch (error) {
    return transactionErrorResponse(error);
  }
}
