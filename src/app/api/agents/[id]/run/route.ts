import { agentRunRequestSchema, agentRunSchema } from "@/lib/contracts";
import { getAgentSession } from "@/lib/agents";
import { agentErrorResponse } from "../error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const body = agentRunRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return Response.json({ code: "INVALID_REQUEST", message: "A non-empty task is required" }, { status: 400 });
    }
    const { agent } = await getAgentSession(id);
    return Response.json(agentRunSchema.parse(await agent.run(body.data.task)));
  } catch (error) {
    return agentErrorResponse(error);
  }
}
