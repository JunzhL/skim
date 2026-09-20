import { getAgentSession } from "@/lib/agents";
import { agentStatusResponseSchema } from "@/lib/contracts";
import { agentErrorResponse } from "./error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    const { agent } = await getAgentSession(id);
    return Response.json(agentStatusResponseSchema.parse(agent.status()));
  } catch (error) {
    return agentErrorResponse(error);
  }
}
