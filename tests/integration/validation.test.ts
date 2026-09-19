import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupDemoRepository } from "@/lib/demo-setup";
import { buildRegistryFromDirectory } from "@/lib/registry";
import { conflictAnalysisRequests, validateSkillSet } from "@/lib/validation";
import { cleanupTempDirectories, copyInto, tempDirectory } from "../helpers/git-fixtures";

afterEach(cleanupTempDirectories);

function demoRepositoryWithSkills(): string {
  const managed = setupDemoRepository(join(tempDirectory("skim-managed-"), "demo"), { appRoot: process.cwd() });
  copyInto(managed, "skills/npm-workflow", "fixtures/authored-skills/npm-workflow");
  copyInto(managed, "skills/algorithmic-art", "fixtures/pinned-skills/algorithmic-art");
  writeFileSync(
    join(managed, "agents.yaml"),
    [
      "schemaVersion: 1",
      "agents:",
      "  - id: builder",
      "    name: Builder",
      "    skills:",
      "      - skillId: package-manager-policy",
      "        enabled: true",
      "        priority: 100",
      "      - skillId: algorithmic-art",
      "        enabled: true",
      "        priority: 50",
      "  - id: reviewer",
      "    name: Reviewer",
      "    skills:",
      "      - skillId: package-manager-policy",
      "        enabled: true",
      "        priority: 100",
      "",
    ].join("\n"),
  );
  return managed;
}

describe("validation against the authored demo skills", () => {
  it("reports one candidate for the pnpm and npm skills and leaves algorithmic-art out", () => {
    const snapshot = buildRegistryFromDirectory(demoRepositoryWithSkills());
    const incoming = snapshot.skills.find((skill) => skill.id === "npm-workflow")!;
    const installed = snapshot.skills.filter((skill) => skill.id !== "npm-workflow");

    expect(installed.map((skill) => `${skill.id}:${skill.enabled}`)).toEqual([
      "algorithmic-art:true",
      "package-manager-policy:true",
    ]);
    expect(incoming.enabled).toBe(false);

    const result = validateSkillSet({ skills: installed, agents: snapshot.agents, incoming });

    expect(result.errors).toEqual([]);
    expect(result.candidates).toEqual([
      {
        skillAId: "npm-workflow",
        skillBId: "package-manager-policy",
        reason: "task-and-file-scope",
        sharedTasks: ["dependency-management"],
        sharedFileGlobs: [{ a: "package.json", b: "package.json" }],
      },
    ]);

    const requests = conflictAnalysisRequests(result);
    expect(requests).toHaveLength(1);
    expect(requests[0].skillA.path).toBe("skills/npm-workflow");
    expect(requests[0].skillB.path).toBe("skills/package-manager-policy");
    expect(requests[0].skillA.workflows).toEqual([
      { task: "dependency-management", executable: "npm", arguments: ["install"], lockfile: "package-lock.json" },
    ]);
  });

  it("blocks analysis when the managed repository has a structural error", () => {
    const managed = demoRepositoryWithSkills();
    writeFileSync(
      join(managed, "skills/npm-workflow/SKILL.md"),
      [
        "---",
        "name: npm-workflow",
        "description: Uses npm for JavaScript dependency changes.",
        "scopes:",
        "  tasks: [dependency-management]",
        "  fileGlobs: [\"package.json\"]",
        "---",
        "",
        "# Package Manager Policy",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(managed, "agents.yaml"),
      [
        "schemaVersion: 1",
        "agents:",
        "  - id: builder",
        "    name: Builder",
        "    skills:",
        "      - skillId: package-manager-policy",
        "        enabled: true",
        "        priority: 100",
        "      - skillId: npm-workflow",
        "        enabled: true",
        "        priority: 90",
        "      - skillId: ghost-skill",
        "        enabled: true",
        "        priority: 10",
        "",
      ].join("\n"),
    );

    const snapshot = buildRegistryFromDirectory(managed);
    const adapter = vi.fn();
    const result = validateSkillSet({ skills: snapshot.skills, agents: snapshot.agents });

    expect(result.errors.map((error) => error.code)).toEqual(["DUPLICATE_SKILL_NAME", "UNKNOWN_ASSIGNMENT"]);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(conflictAnalysisRequests(result)).toEqual([]);
    conflictAnalysisRequests(result).forEach(adapter);
    expect(adapter).not.toHaveBeenCalled();
  });
});
