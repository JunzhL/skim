import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeConflict, createMockConflictAdapter, directoryConflictSource } from "@/lib/conflicts";
import { setupDemoRepository } from "@/lib/demo-setup";
import { buildRegistryFromDirectory } from "@/lib/registry";
import { conflictAnalysisRequests, validateSkillSet } from "@/lib/validation";
import {
  cleanupTempDirectories,
  copyInto,
  git,
  tempDirectory,
  workingTreeStatus,
} from "../helpers/git-fixtures";

afterEach(cleanupTempDirectories);

describe("conflict analysis against authored skill files", () => {
  it.each([
    ["openai" as const, "gpt-5.6-terra"],
    ["deepseek" as const, "deepseek-flash"],
  ])("verifies cited pnpm/npm instructions for %s without modifying Git", async (provider, model) => {
    const managed = setupDemoRepository(join(tempDirectory("skim-managed-"), "demo"), { appRoot: process.cwd() });
    copyInto(managed, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");

    const snapshot = buildRegistryFromDirectory(managed);
    const incoming = snapshot.skills.find((skill) => skill.id === "npm-workflow")!;
    const installed = snapshot.skills.filter((skill) => skill.id !== "npm-workflow");
    const requests = conflictAnalysisRequests(
      validateSkillSet({ skills: installed, agents: snapshot.agents, incoming }),
    );
    expect(requests).toHaveLength(1);

    const npmText = readFileSync(join(managed, "skills/npm-workflow/SKILL.md"), "utf8");
    const pnpmText = readFileSync(join(managed, "skills/package-manager-policy/SKILL.md"), "utf8");
    const npmLine = npmText.split("\n").findIndex((line) => line.includes("use `npm install`")) + 1;
    const pnpmLine = pnpmText.split("\n").findIndex((line) => line.includes("use `pnpm add`")) + 1;
    expect(npmLine).toBeGreaterThan(0);
    expect(pnpmLine).toBeGreaterThan(0);

    const beforeHead = git(managed, "rev-parse", "HEAD");
    const beforeStatus = workingTreeStatus(managed);
    const report = await analyzeConflict(requests[0], {
      source: directoryConflictSource(managed),
      adapter: createMockConflictAdapter(provider, model, {
        commonScenario: "Adding a JavaScript dependency",
        confidence: 0.99,
        explanation: "One skill requires npm/package-lock while the other requires pnpm/pnpm-lock for the same dependency-management task.",
        evidence: [
          {
            skillId: "npm-workflow",
            filePath: "SKILL.md",
            lineStart: npmLine,
            lineEnd: npmLine,
            quote: "use `npm install`",
          },
          {
            skillId: "package-manager-policy",
            filePath: "SKILL.md",
            lineStart: pnpmLine,
            lineEnd: pnpmLine,
            quote: "use `pnpm add`",
          },
        ],
      }),
    });

    expect(report.analysis).toEqual({ provider, model });
    expect(report.skillAId).toBe("npm-workflow");
    expect(report.skillBId).toBe("package-manager-policy");
    expect(report.evidence.map((evidence) => evidence.skillId).sort()).toEqual([
      "npm-workflow",
      "package-manager-policy",
    ]);
    expect(git(managed, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(workingTreeStatus(managed)).toBe(beforeStatus);
  });
});
