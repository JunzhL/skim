import { getRegistryResponseSchema } from "@/lib/contracts";
import { SkimError } from "@/lib/errors";
import { readRegistry } from "@/lib/registry";
import { validateRuntimeConfig } from "@/lib/runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    const { repoPath } = validateRuntimeConfig(process.env);
    return Response.json(getRegistryResponseSchema.parse(readRegistry(repoPath)));
  } catch (error) {
    if (error instanceof SkimError) {
      return Response.json(error.toApiError(), { status: 409 });
    }
    return Response.json(
      { code: "REGISTRY_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
