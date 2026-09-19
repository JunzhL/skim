import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { agentRunSchema, type AgentConfig, type SkillRecord } from "@/lib/contracts";
import {
  createBuilderAgent,
  createReviewerAgent,
  DemoAgentConfigurationError,
  type InterceptedCommand,
  type RegistrySnapshot,
} from "@/lib/agents";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const hash = "1".repeat(64);
const timestamp = new Date("2026-09-19T20:00:00.000Z");

function skill(id: "package-manager-policy" | "npm-workflow"): SkillRecord {
  return {
    id,
    name: id === "package-manager-policy" ? "Package Manager Policy" : "NPM Workflow",
    description: id,
    path: `skills/${id}`,
    source: { type: "builtin", name: id },
    files: [{ path: `skills/${id}/SKILL.md`, hash }],
    scopes: { tasks: ["dependency-addition"], fileGlobs: ["package.json"] },
    enabled: true,
  };
}

function agent(id: "builder" | "reviewer", activeSkillId: "package-manager-policy" | "npm-workflow"): AgentConfig {
  return {
    id,
    name: id === "builder" ? "Builder" : "Reviewer",
    skills: [
      { skillId: "package-manager-policy", enabled: activeSkillId === "package-manager-policy", priority: 100 },
      { skillId: "npm-workflow", enabled: activeSkillId === "npm-workflow", priority: 100 },
    ],
  };
}

function registry(configurationCommit: string, activeSkillId: "package-manager-policy" | "npm-workflow"): RegistrySnapshot {
  return {
    configurationCommit,
    skills: [skill("package-manager-policy"), skill("npm-workflow")],
    agents: [agent("builder", activeSkillId), agent("reviewer", activeSkillId)],
  };
}

describe("reloadable demo agents", () => {
  it("pins a loaded snapshot until each agent explicitly reloads", async () => {
    let current = registry(commitA, "package-manager-policy");
    const commands: InterceptedCommand[] = [];
    let runSequence = 0;

    const registryReader = async () => current;
    const commandInterceptor = async (command: InterceptedCommand) => {
      expect(existsSync(command.cwd)).toBe(true);
      expect(command.cwd.startsWith(tmpdir())).toBe(true);
      commands.push(command);
    };
    const createRunId = () => `run-${++runSequence}`;
    const now = () => timestamp;

    const builder = createBuilderAgent({ registryReader, commandInterceptor, createRunId, now });
    const reviewer = createReviewerAgent({ registryReader, commandInterceptor, createRunId, now });

    await expect(builder.reload()).resolves.toEqual({ agentId: "builder", loadedConfigurationCommit: commitA });
    await expect(reviewer.reload()).resolves.toEqual({ agentId: "reviewer", loadedConfigurationCommit: commitA });

    current = registry(commitB, "npm-workflow");

    const staleBuilderRun = await builder.run("add zod");
    const staleReviewerRun = await reviewer.run("add zod");

    expect(staleBuilderRun.configurationCommit).toBe(commitA);
    expect(staleReviewerRun.configurationCommit).toBe(commitA);
    expect(staleBuilderRun.interceptedExecutable).toBe("pnpm");
    expect(staleBuilderRun.interceptedArguments).toEqual(["add", "zod"]);
    expect(staleBuilderRun.expectedLockfile).toBe("pnpm-lock.yaml");
    expect(staleReviewerRun.interceptedExecutable).toBe("pnpm");

    await builder.reload();
    const freshBuilderRun = await builder.run("add zod");
    const stillStaleReviewerRun = await reviewer.run("add zod");

    expect(freshBuilderRun.configurationCommit).toBe(commitB);
    expect(freshBuilderRun.interceptedExecutable).toBe("npm");
    expect(freshBuilderRun.interceptedArguments).toEqual(["install", "zod"]);
    expect(freshBuilderRun.expectedLockfile).toBe("package-lock.json");
    expect(stillStaleReviewerRun.configurationCommit).toBe(commitA);
    expect(stillStaleReviewerRun.interceptedExecutable).toBe("pnpm");

    await reviewer.reload();
    const freshReviewerRun = await reviewer.run("add zod");
    expect(freshReviewerRun.configurationCommit).toBe(commitB);
    expect(freshReviewerRun.interceptedExecutable).toBe("npm");
    expect(freshReviewerRun.expectedLockfile).toBe("package-lock.json");

    for (const run of [staleBuilderRun, staleReviewerRun, freshBuilderRun, stillStaleReviewerRun, freshReviewerRun]) {
      expect(agentRunSchema.parse(run)).toEqual(run);
      expect(run.task).toBe("add zod");
      expect(run.timestamp).toBe(timestamp.toISOString());
    }

    expect(commands).toHaveLength(5);
    for (const command of commands) {
      expect(existsSync(command.cwd)).toBe(false);
    }
  });

  it("fails instead of silently choosing when multiple package-manager policies are active", async () => {
    const ambiguous = registry(commitA, "package-manager-policy");
    for (const configuredAgent of ambiguous.agents) {
      configuredAgent.skills = configuredAgent.skills.map((assignment) => ({ ...assignment, enabled: true }));
    }

    const builder = createBuilderAgent({
      registryReader: async () => ambiguous,
      commandInterceptor: () => undefined,
    });

    await builder.reload();
    await expect(builder.run("add zod")).rejects.toMatchObject({
      code: "AMBIGUOUS_PACKAGE_MANAGER_POLICY",
    });
  });

  it("fails explicitly when no package-manager policy is active", async () => {
    const missing = registry(commitA, "package-manager-policy");
    for (const configuredAgent of missing.agents) {
      configuredAgent.skills = configuredAgent.skills.map((assignment) => ({ ...assignment, enabled: false }));
    }

    const reviewer = createReviewerAgent({
      registryReader: async () => missing,
      commandInterceptor: () => undefined,
    });

    await reviewer.reload();
    await expect(reviewer.run("add zod")).rejects.toMatchObject({
      code: "NO_PACKAGE_MANAGER_POLICY",
    });
  });

  it("never invokes a real package manager process", async () => {
    const observed: InterceptedCommand[] = [];
    const builder = createBuilderAgent({
      registryReader: async () => registry(commitA, "package-manager-policy"),
      commandInterceptor: (command) => {
        observed.push(command);
      },
      createRunId: () => "run-no-network",
      now: () => timestamp,
    });

    await builder.reload();
    const run = await builder.run("install vitest");

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ executable: "pnpm", arguments: ["add", "vitest"] });
    expect(run).toMatchObject({
      runId: "run-no-network",
      agentId: "builder",
      task: "install vitest",
      configurationCommit: commitA,
      interceptedExecutable: "pnpm",
      interceptedArguments: ["add", "vitest"],
      expectedLockfile: "pnpm-lock.yaml",
      status: "completed",
      timestamp: timestamp.toISOString(),
    });
  });
});
