import { agentReloadResponseSchema } from "@/lib/contracts";
import { getAgentSession } from "@/lib/agents";
import { agentErrorResponse } from "../error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const { agent } = await getAgentSession(id);
    return Response.json(agentReloadResponseSchema.parse(await agent.reload()));
  } catch (error) {
    return agentErrorResponse(error);
  }
}
