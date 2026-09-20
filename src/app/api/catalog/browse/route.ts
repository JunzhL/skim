import { browseCatalogRequestSchema, browseCatalogResponseSchema } from "@/lib/contracts";
import { browseRepositorySkills } from "@/lib/catalog";
import { transactionErrorResponse } from "../../transaction-error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const { url, commit } = browseCatalogRequestSchema.parse(await request.json());
    const skills = browseRepositorySkills({ url, commit });
    return Response.json(browseCatalogResponseSchema.parse({ url, commit, skills }));
  } catch (error) {
    return transactionErrorResponse(error);
  }
}
