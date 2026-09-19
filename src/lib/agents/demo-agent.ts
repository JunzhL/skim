import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig, AgentRun, SkillRecord } from "@/lib/contracts";

export type RegistrySnapshot = {
  configurationCommit: string;
  skills: SkillRecord[];
  agents: AgentConfig[];
};

export type RegistryReader = () => Promise<RegistrySnapshot>;

export type InterceptedCommand = {
  executable: string;
  arguments: string[];
  cwd: string;
};

export type CommandInterceptor = (command: InterceptedCommand) => void | Promise<void>;

export type DemoAgentOptions = {
  agentId: "builder" | "reviewer";
  registryReader: RegistryReader;
  commandInterceptor: CommandInterceptor;
  now?: () => Date;
  createRunId?: () => string;
};

type PackageManagerPolicy = {
  skillId: "package-manager-policy" | "npm-workflow";
  executable: "pnpm" | "npm";
  installVerb: "add" | "install";
  lockfile: "pnpm-lock.yaml" | "package-lock.json";
};

const PACKAGE_MANAGER_POLICIES: readonly PackageManagerPolicy[] = [
  {
    skillId: "package-manager-policy",
    executable: "pnpm",
    installVerb: "add",
    lockfile: "pnpm-lock.yaml",
  },
  {
    skillId: "npm-workflow",
    executable: "npm",
    installVerb: "install",
    lockfile: "package-lock.json",
  },
];

export class DemoAgentConfigurationError extends Error {
  readonly code:
    | "AGENT_NOT_LOADED"
    | "AGENT_NOT_FOUND"
    | "NO_PACKAGE_MANAGER_POLICY"
    | "AMBIGUOUS_PACKAGE_MANAGER_POLICY"
    | "UNSUPPORTED_TASK";

  constructor(
    code:
      | "AGENT_NOT_LOADED"
      | "AGENT_NOT_FOUND"
      | "NO_PACKAGE_MANAGER_POLICY"
      | "AMBIGUOUS_PACKAGE_MANAGER_POLICY"
      | "UNSUPPORTED_TASK",
    message: string,
  ) {
    super(message);
    this.name = "DemoAgentConfigurationError";
    this.code = code;
  }
}

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

  get id(): "builder" | "reviewer" {
    return this.options.agentId;
  }

  get loadedConfigurationCommit(): string | null {
    return this.loadedSnapshot?.configurationCommit ?? null;
  }

  async reload(): Promise<{ agentId: string; loadedConfigurationCommit: string }> {
    const nextSnapshot = structuredClone(await this.options.registryReader());
    this.requireAgent(nextSnapshot);
    this.loadedSnapshot = nextSnapshot;

    return {
      agentId: this.id,
      loadedConfigurationCommit: nextSnapshot.configurationCommit,
    };
  }

  async run(task: string): Promise<AgentRun> {
    const snapshot = this.requireLoadedSnapshot();
    const agent = this.requireAgent(snapshot);
    const policy = this.resolvePackageManagerPolicy(snapshot, agent);
    const dependency = extractDependency(task);
    const workspace = await mkdtemp(join(tmpdir(), `skim-${this.id}-`));

    try {
      const args = [policy.installVerb, dependency];
      await this.options.commandInterceptor({
        executable: policy.executable,
        arguments: args,
        cwd: workspace,
      });

      return {
        runId: this.createRunId(),
        agentId: this.id,
        task,
        configurationCommit: snapshot.configurationCommit,
        interceptedExecutable: policy.executable,
        interceptedArguments: args,
        expectedLockfile: policy.lockfile,
        status: "completed",
        timestamp: this.now().toISOString(),
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
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
      );
    }
    return agent;
  }

  private resolvePackageManagerPolicy(snapshot: RegistrySnapshot, agent: AgentConfig): PackageManagerPolicy {
    const enabledSkillIds = new Set(
      agent.skills
        .filter((assignment) => assignment.enabled)
        .map((assignment) => assignment.skillId),
    );

    const activePolicies = PACKAGE_MANAGER_POLICIES.filter((policy) => {
      if (!enabledSkillIds.has(policy.skillId)) {
        return false;
      }
      return snapshot.skills.some((skill) => skill.id === policy.skillId && skill.enabled);
    });

    if (activePolicies.length === 0) {
      throw new DemoAgentConfigurationError(
        "NO_PACKAGE_MANAGER_POLICY",
        `Agent ${this.id} has no active package-manager policy in configuration ${snapshot.configurationCommit}.`,
      );
    }

    if (activePolicies.length > 1) {
      throw new DemoAgentConfigurationError(
        "AMBIGUOUS_PACKAGE_MANAGER_POLICY",
        `Agent ${this.id} has multiple active package-manager policies in configuration ${snapshot.configurationCommit}.`,
      );
    }

    return activePolicies[0];
  }
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
    );
  }
  return match[1];
}
