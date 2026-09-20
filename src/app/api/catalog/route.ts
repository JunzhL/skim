import { getCatalogResponseSchema } from "@/lib/contracts";
import { readCuratedCatalog } from "@/lib/catalog";
import { transactionErrorResponse } from "../transaction-error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return Response.json(getCatalogResponseSchema.parse({ entries: readCuratedCatalog() }));
  } catch (error) {
    return transactionErrorResponse(error);
  }
}
