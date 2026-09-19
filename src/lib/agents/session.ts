import { readRegistry } from "../registry";
import { validateRuntimeConfig } from "../runtime-config";
import { createDemoAgent, ReloadableDemoAgent } from "./demo-agent";
import { createRecordingInterceptor, type RecordingInterceptor } from "./interceptor";

type AgentSession = { agent: ReloadableDemoAgent; interceptor: RecordingInterceptor };

const STORE = Symbol.for("skim.demo-agent-sessions");

function store(): Map<string, AgentSession> {
  const host = globalThis as typeof globalThis & { [STORE]?: Map<string, AgentSession> };
  host[STORE] ??= new Map<string, AgentSession>();
  return host[STORE];
}

export async function getAgentSession(agentId: string): Promise<AgentSession> {
  const existing = store().get(agentId);
  if (existing) return existing;

  const interceptor = createRecordingInterceptor();
  const agent = createDemoAgent({
    agentId,
    registryReader: async () => readRegistry(validateRuntimeConfig(process.env).repoPath),
    commandInterceptor: interceptor,
  });
  await agent.reload();

  const session = { agent, interceptor };
  store().set(agentId, session);
  return session;
}

export function resetAgentSessions(): void {
  store().clear();
}
