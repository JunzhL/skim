import { DemoAgentConfigurationError } from "@/lib/agents";
import { SkimError } from "@/lib/errors";

export function agentErrorResponse(error: unknown): Response {
  if (error instanceof DemoAgentConfigurationError) {
    return Response.json({ code: error.code, message: error.message, details: error.details }, { status: 409 });
  }
  if (error instanceof SkimError) {
    return Response.json(error.toApiError(), { status: 409 });
  }
  return Response.json(
    { code: "AGENT_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}
