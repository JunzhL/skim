import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoAgent, createRecordingInterceptor, DemoAgentConfigurationError, type RecordingInterceptor } from "@/lib/agents";
import { agentRunSchema } from "@/lib/contracts";
import { setupDemoRepository } from "@/lib/demo-setup";
import { readRegistry } from "@/lib/registry";
import { cleanupTempDirectories, commitAll, copyInto, git, tempDirectory } from "../helpers/git-fixtures";

const interceptors: RecordingInterceptor[] = [];

afterEach(() => {
  for (const interceptor of interceptors.splice(0)) {
    for (const command of interceptor.commands) rmSync(command.cwd, { recursive: true, force: true });
  }
  cleanupTempDirectories();
});

function managedRepository(): string {
  return setupDemoRepository(join(tempDirectory("skim-managed-"), "demo"), { appRoot: process.cwd() });
}

function agentsYaml(entries: { agent: string; name: string; skills: { id: string; enabled: boolean; priority: number }[] }[]): string {
  return [
    "schemaVersion: 1",
    "agents:",
    ...entries.flatMap(({ agent, name, skills }) => [
      `  - id: ${agent}`,
      `    name: ${name}`,
      "    skills:",
      ...skills.flatMap((skill) => [
        `      - skillId: ${skill.id}`,
        `        enabled: ${skill.enabled}`,
        `        priority: ${skill.priority}`,
      ]),
    ]),
    "",
  ].join("\n");
}

function activateNpmWorkflow(managed: string): string {
  copyInto(managed, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
  writeFileSync(
    join(managed, "agents.yaml"),
    agentsYaml(
      ["builder", "reviewer"].map((agent) => ({
        agent,
        name: agent === "builder" ? "Builder" : "Reviewer",
        skills: [
          { id: "package-manager-policy", enabled: false, priority: 100 },
          { id: "npm-workflow", enabled: true, priority: 100 },
        ],
      })),
    ),
  );
  return commitAll(managed, "activate npm workflow and pause the pnpm policy");
}

function demoAgents(managed: string) {
  const interceptor = createRecordingInterceptor();
  interceptors.push(interceptor);
  const make = (agentId: string) =>
    createDemoAgent({
      agentId,
      registryReader: async () => readRegistry(managed),
      commandInterceptor: interceptor,
      keepWorkspace: true,
    });
  return { interceptor, builder: make("builder"), reviewer: make("reviewer") };
}

describe("reloadable demo agents against a managed repository", () => {
  it("loads one committed version, changes command only after an explicit reload", async () => {
    const managed = managedRepository();
    const firstCommit = git(managed, "rev-parse", "HEAD");
    const { interceptor, builder, reviewer } = demoAgents(managed);

    await builder.reload();
    await reviewer.reload();
    expect(builder.status()).toEqual({
      agentId: "builder",
      name: "Builder",
      loadedConfigurationCommit: firstCommit,
      activeSkillIds: ["package-manager-policy"],
    });
    expect(reviewer.loadedConfigurationCommit).toBe(firstCommit);

    const initialRuns = [await builder.run("add zod"), await reviewer.run("add zod")];
    for (const run of initialRuns) {
      expect(agentRunSchema.parse(run)).toEqual(run);
      expect(run.configurationCommit).toBe(firstCommit);
      expect(run.interceptedExecutable).toBe("pnpm");
      expect(run.interceptedArguments).toEqual(["add", "zod"]);
      expect(run.expectedLockfile).toBe("pnpm-lock.yaml");
      expect(run.status).toBe("completed");
    }

    const secondCommit = activateNpmWorkflow(managed);
    expect(secondCommit).not.toBe(firstCommit);
    expect(readRegistry(managed).configurationCommit).toBe(secondCommit);

    const staleRuns = [await builder.run("add zod"), await reviewer.run("add zod")];
    for (const run of staleRuns) {
      expect(run.configurationCommit).toBe(firstCommit);
      expect(run.interceptedExecutable).toBe("pnpm");
      expect(run.expectedLockfile).toBe("pnpm-lock.yaml");
    }

    await builder.reload();
    const reloadedBuilderRun = await builder.run("add zod");
    const stillStaleReviewerRun = await reviewer.run("add zod");

    expect(builder.status().activeSkillIds).toEqual(["npm-workflow"]);
    expect(reloadedBuilderRun.configurationCommit).toBe(secondCommit);
    expect(reloadedBuilderRun.interceptedExecutable).toBe("npm");
    expect(reloadedBuilderRun.interceptedArguments).toEqual(["install", "zod"]);
    expect(reloadedBuilderRun.expectedLockfile).toBe("package-lock.json");
    expect(stillStaleReviewerRun.configurationCommit).toBe(firstCommit);
    expect(stillStaleReviewerRun.interceptedExecutable).toBe("pnpm");

    await expect(reviewer.reload()).resolves.toEqual({ agentId: "reviewer", loadedConfigurationCommit: secondCommit });
    const reloadedReviewerRun = await reviewer.run("add zod");
    expect(reloadedReviewerRun.configurationCommit).toBe(secondCommit);
    expect(reloadedReviewerRun.interceptedExecutable).toBe("npm");
    expect(reloadedReviewerRun.expectedLockfile).toBe("package-lock.json");

    expect(interceptor.commands.map((command) => `${command.executable} ${command.arguments.join(" ")}`)).toEqual([
      "pnpm add zod",
      "pnpm add zod",
      "pnpm add zod",
      "pnpm add zod",
      "npm install zod",
      "pnpm add zod",
      "npm install zod",
    ]);
    expect(interceptor.commands.map((command) => command.skillId)).toEqual([
      "package-manager-policy",
      "package-manager-policy",
      "package-manager-policy",
      "package-manager-policy",
      "npm-workflow",
      "package-manager-policy",
      "npm-workflow",
    ]);
  });

  it("intercepts the workflow inside an isolated workspace without installing anything", async () => {
    const managed = managedRepository();
    const { interceptor, builder } = demoAgents(managed);
    await builder.reload();
    await builder.run("add zod");

    const command = interceptor.commands[0];

    expect(command.cwd.startsWith(managed)).toBe(false);
    expect(existsSync(join(command.cwd, "node_modules"))).toBe(false);
    expect(JSON.parse(readFileSync(join(command.cwd, "package.json"), "utf8")).dependencies).toEqual({ zod: "*" });
    expect(readFileSync(join(command.cwd, "pnpm-lock.yaml"), "utf8")).toContain("instead of running: pnpm add zod");
    expect(existsSync(join(command.cwd, "package-lock.json"))).toBe(false);
    expect(git(managed, "status", "--porcelain")).toBe("");
  });

  it("refuses to guess when the committed configuration leaves no single workflow", async () => {
    const managed = managedRepository();
    writeFileSync(
      join(managed, "agents.yaml"),
      agentsYaml([{ agent: "builder", name: "Builder", skills: [{ id: "package-manager-policy", enabled: false, priority: 100 }] }]),
    );
    commitAll(managed, "pause every skill");

    const { builder } = demoAgents(managed);
    await builder.reload();
    await expect(builder.run("add zod")).rejects.toBeInstanceOf(DemoAgentConfigurationError);
    await expect(builder.run("add zod")).rejects.toMatchObject({ code: "NO_PACKAGE_MANAGER_POLICY" });

    copyInto(managed, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
    writeFileSync(
      join(managed, "agents.yaml"),
      agentsYaml([
        {
          agent: "builder",
          name: "Builder",
          skills: [
            { id: "package-manager-policy", enabled: true, priority: 100 },
            { id: "npm-workflow", enabled: true, priority: 100 },
          ],
        },
      ]),
    );
    commitAll(managed, "activate both package-manager policies");

    await builder.reload();
    await expect(builder.run("add zod")).rejects.toMatchObject({
      code: "AMBIGUOUS_PACKAGE_MANAGER_POLICY",
      details: { skillIds: ["npm-workflow", "package-manager-policy"] },
    });
  });

  it("refuses multiple active workflows even when assignment priorities differ", async () => {
    const managed = managedRepository();
    copyInto(managed, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
    writeFileSync(
      join(managed, "agents.yaml"),
      agentsYaml([
        {
          agent: "builder",
          name: "Builder",
          skills: [
            { id: "package-manager-policy", enabled: true, priority: 10 },
            { id: "npm-workflow", enabled: true, priority: 90 },
          ],
        },
      ]),
    );
    commitAll(managed, "activate conflicting workflows with different priorities");

    const { builder } = demoAgents(managed);
    await builder.reload();
    await expect(builder.run("add zod")).rejects.toMatchObject({
      code: "AMBIGUOUS_PACKAGE_MANAGER_POLICY",
      details: { skillIds: ["npm-workflow", "package-manager-policy"] },
    });
  });

  it("rejects tasks that are not dependency additions", async () => {
    const { builder } = demoAgents(managedRepository());
    await builder.reload();
    await expect(builder.run("refactor the router")).rejects.toMatchObject({ code: "UNSUPPORTED_TASK" });
  });
});
