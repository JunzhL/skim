import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig, AgentRun, SkillRecord, SkillWorkflow } from "@/lib/contracts";
import type { Registry } from "@/lib/registry";

export type RegistrySnapshot = Registry;

export type RegistryReader = () => Promise<RegistrySnapshot>;

export type InterceptedCommand = {
  executable: string;
  arguments: string[];
  cwd: string;
  lockfile: string;
  dependency: string;
  skillId: string;
};

export type CommandInterceptor = (command: InterceptedCommand) => void | Promise<void>;

export type DemoAgentOptions = {
  agentId: string;
  registryReader: RegistryReader;
  commandInterceptor: CommandInterceptor;
  now?: () => Date;
  createRunId?: () => string;
  keepWorkspace?: boolean;
};

export type DemoAgentStatus = {
  agentId: string;
  name: string;
  loadedConfigurationCommit: string | null;
  activeSkillIds: string[];
};

export const DEPENDENCY_TASK = "dependency-management";

const WORKSPACE_PACKAGE_JSON = `${JSON.stringify({ name: "skim-demo-workspace", version: "0.0.0", private: true, dependencies: {} }, null, 2)}\n`;

type DemoAgentErrorCode =
  | "AGENT_NOT_LOADED"
  | "AGENT_NOT_FOUND"
  | "NO_PACKAGE_MANAGER_POLICY"
  | "AMBIGUOUS_PACKAGE_MANAGER_POLICY"
  | "UNSUPPORTED_TASK";

export class DemoAgentConfigurationError extends Error {
  readonly code: DemoAgentErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: DemoAgentErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DemoAgentConfigurationError";
    this.code = code;
    this.details = details;
  }
}

type ResolvedWorkflow = { skillId: string; workflow: SkillWorkflow };

export class ReloadableDemoAgent {
  private loadedSnapshot: RegistrySnapshot | null = null;
  private readonly now: () => Date;
  private readonly createRunId: () => string;
  private readonly options: DemoAgentOptions;

  constructor(options: DemoAgentOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.createRunId = options.createRunId ?? (() => `run-${randomUUID()}`);
  }

  get id(): string {
    return this.options.agentId;
  }

  get loadedConfigurationCommit(): string | null {
    return this.loadedSnapshot?.configurationCommit ?? null;
  }

  status(): DemoAgentStatus {
    if (this.loadedSnapshot === null) {
      return { agentId: this.id, name: this.id, loadedConfigurationCommit: null, activeSkillIds: [] };
    }
    const agent = this.requireAgent(this.loadedSnapshot);
    return {
      agentId: this.id,
      name: agent.name,
      loadedConfigurationCommit: this.loadedSnapshot.configurationCommit,
      activeSkillIds: this.activeSkills(this.loadedSnapshot, agent).map(({ skill }) => skill.id),
    };
  }

  async reload(): Promise<{ agentId: string; loadedConfigurationCommit: string }> {
    const nextSnapshot = structuredClone(await this.options.registryReader());
    this.requireAgent(nextSnapshot);
    this.loadedSnapshot = nextSnapshot;

    return { agentId: this.id, loadedConfigurationCommit: nextSnapshot.configurationCommit };
  }

  async run(task: string): Promise<AgentRun> {
    const snapshot = this.requireLoadedSnapshot();
    const agent = this.requireAgent(snapshot);
    const { skillId, workflow } = this.resolveWorkflow(snapshot, agent, DEPENDENCY_TASK);
    const dependency = extractDependency(task);
    const workspace = await mkdtemp(join(tmpdir(), `skim-${this.id}-`));

    try {
      await writeFile(join(workspace, "package.json"), WORKSPACE_PACKAGE_JSON);
      const args = [...workflow.arguments, dependency];
      await this.options.commandInterceptor({
        executable: workflow.executable,
        arguments: args,
        cwd: workspace,
        lockfile: workflow.lockfile,
        dependency,
        skillId,
      });

      return {
        runId: this.createRunId(),
        agentId: this.id,
        task,
        configurationCommit: snapshot.configurationCommit,
        interceptedExecutable: workflow.executable,
        interceptedArguments: args,
        expectedLockfile: workflow.lockfile,
        status: "completed",
        timestamp: this.now().toISOString(),
      };
    } finally {
      if (!this.options.keepWorkspace) await rm(workspace, { recursive: true, force: true });
    }
  }

  private requireLoadedSnapshot(): RegistrySnapshot {
    if (this.loadedSnapshot === null) {
      throw new DemoAgentConfigurationError(
        "AGENT_NOT_LOADED",
        `Agent ${this.id} has not loaded a registry snapshot yet. Call reload() first.`,
      );
    }
    return this.loadedSnapshot;
  }

  private requireAgent(snapshot: RegistrySnapshot): AgentConfig {
    const agent = snapshot.agents.find((candidate) => candidate.id === this.id);
    if (agent === undefined) {
      throw new DemoAgentConfigurationError(
        "AGENT_NOT_FOUND",
        `Agent ${this.id} is not present in configuration ${snapshot.configurationCommit}.`,
        { configurationCommit: snapshot.configurationCommit },
      );
    }
    return agent;
  }

  private activeSkills(snapshot: RegistrySnapshot, agent: AgentConfig): { skill: SkillRecord; priority: number }[] {
    return agent.skills
      .filter((assignment) => assignment.enabled)
      .flatMap((assignment) => {
        const skill = snapshot.skills.find((candidate) => candidate.id === assignment.skillId && candidate.enabled);
        return skill ? [{ skill, priority: assignment.priority }] : [];
      })
      .sort((a, b) => b.priority - a.priority || (a.skill.id < b.skill.id ? -1 : 1));
  }

  private resolveWorkflow(snapshot: RegistrySnapshot, agent: AgentConfig, task: string): ResolvedWorkflow {
    const declared = this.activeSkills(snapshot, agent).flatMap(({ skill, priority }) => {
      const workflow = skill.workflows?.find((candidate) => candidate.task === task);
      return workflow ? [{ skillId: skill.id, workflow, priority }] : [];
    });

    if (declared.length === 0) {
      throw new DemoAgentConfigurationError(
        "NO_PACKAGE_MANAGER_POLICY",
        `Agent ${this.id} has no active skill declaring the ${task} workflow in configuration ${snapshot.configurationCommit}.`,
        { task, configurationCommit: snapshot.configurationCommit },
      );
    }

    const priorities = declared.map((entry) => ({ skillId: entry.skillId, priority: entry.priority }));
    const contenders = declared;
    if (contenders.length > 1) {
      throw new DemoAgentConfigurationError(
        "AMBIGUOUS_PACKAGE_MANAGER_POLICY",
        `Agent ${this.id} has ${contenders.length} active skills declaring the ${task} workflow in configuration ${snapshot.configurationCommit}.`,
        { task, priorities, skillIds: contenders.map((entry) => entry.skillId) },
      );
    }

    return { skillId: declared[0].skillId, workflow: declared[0].workflow };
  }
}

export function createDemoAgent(options: DemoAgentOptions): ReloadableDemoAgent {
  return new ReloadableDemoAgent(options);
}

export function createBuilderAgent(options: Omit<DemoAgentOptions, "agentId">): ReloadableDemoAgent {
  return new ReloadableDemoAgent({ ...options, agentId: "builder" });
}

export function createReviewerAgent(options: Omit<DemoAgentOptions, "agentId">): ReloadableDemoAgent {
  return new ReloadableDemoAgent({ ...options, agentId: "reviewer" });
}

function extractDependency(task: string): string {
  const match = task.match(/\b(?:add|install)\s+([@a-z0-9][^\s,;]*)/i);
  if (match === null) {
    throw new DemoAgentConfigurationError(
      "UNSUPPORTED_TASK",
      `Demo agents only support dependency-addition tasks such as "add zod". Received: ${task}`,
      { task },
    );
  }
  return match[1];
}
