import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRegistryResponseSchema } from "@/lib/contracts";
import { setupDemoRepository } from "@/lib/demo-setup";
import { isSkimError } from "@/lib/errors";
import { buildRegistryFromDirectory, materializeRegistry, readRegistry, REGISTRY_FILE } from "@/lib/registry";
import { importPinnedSkill } from "@/lib/skills/import";
import {
  cleanupTempDirectories,
  commitAll,
  copyInto,
  git,
  initRepository,
  remoteUrl,
  tempDirectory,
} from "../helpers/git-fixtures";

const pinnedFixture = JSON.parse(readFileSync("fixtures/pinned-skills/algorithmic-art.source.json", "utf8")) as {
  subdirectory: string;
  license: string;
  licenseFiles: string[];
  files: { path: string; hash: string }[];
};

afterEach(cleanupTempDirectories);

function managedRepository(): string {
  return setupDemoRepository(join(tempDirectory("skim-managed-"), "demo"), { appRoot: process.cwd() });
}

function importedManagedRepository(): { managed: string; url: string; commit: string } {
  const managed = managedRepository();
  const source = initRepository(tempDirectory("skim-source-"));
  copyInto(source, "skills/algorithmic-art", "fixtures/pinned-skills/algorithmic-art");
  const commit = commitAll(source, "add algorithmic-art");
  const url = remoteUrl(source);

  const imported = importPinnedSkill({ source: { url, commit, subdirectory: pinnedFixture.subdirectory }, destinationRoot: managed });
  materializeRegistry(managed, new Map([[imported.slug, imported.provenance]]));
  commitAll(managed, "import algorithmic-art");
  return { managed, url, commit };
}

describe("registry snapshot", () => {
  it("records provenance, hashes, scopes, assignments, and enabled state", () => {
    const { managed, url, commit } = importedManagedRepository();
    const file = JSON.parse(readFileSync(join(managed, ...REGISTRY_FILE.split("/")), "utf8"));

    expect(file.schemaVersion).toBe(1);
    expect(file.skills.map((skill: { id: string }) => skill.id)).toEqual(["algorithmic-art", "package-manager-policy"]);

    const [imported, builtin] = file.skills;
    expect(imported).toMatchObject({
      id: "algorithmic-art",
      name: "Algorithmic Art",
      path: "skills/algorithmic-art",
      source: {
        type: "git",
        url,
        commit,
        subdirectory: pinnedFixture.subdirectory,
        license: pinnedFixture.license,
        licenseFiles: pinnedFixture.licenseFiles,
      },
      files: pinnedFixture.files,
      scopes: { tasks: [], fileGlobs: [] },
      enabled: false,
    });
    expect(builtin).toMatchObject({
      id: "package-manager-policy",
      name: "Package Manager Policy",
      source: { type: "builtin", name: "package-manager-policy" },
      enabled: true,
    });
    expect(builtin.files).toHaveLength(1);
    expect(builtin.files[0].path).toBe("SKILL.md");
    expect(builtin.files[0].hash).toMatch(/^[0-9a-f]{64}$/);

    expect(file.agents).toEqual([
      { id: "builder", name: "Builder", skills: [{ skillId: "package-manager-policy", enabled: true, priority: 100 }] },
      { id: "reviewer", name: "Reviewer", skills: [{ skillId: "package-manager-policy", enabled: true, priority: 100 }] },
    ]);
  });

  it("writes byte-identical registry files for the same tree", () => {
    const { managed } = importedManagedRepository();
    const target = join(managed, ...REGISTRY_FILE.split("/"));
    const first = readFileSync(target, "utf8");
    materializeRegistry(managed);
    expect(readFileSync(target, "utf8")).toBe(first);
  });

  it("derives enabled state from agents.yaml assignments", () => {
    const managed = managedRepository();
    expect(buildRegistryFromDirectory(managed).skills[0].enabled).toBe(true);

    writeFileSync(
      join(managed, "agents.yaml"),
      "schemaVersion: 1\nagents:\n  - id: builder\n    name: Builder\n    skills:\n      - skillId: package-manager-policy\n        enabled: false\n        priority: 100\n",
    );
    const paused = buildRegistryFromDirectory(managed);
    expect(paused.skills[0].enabled).toBe(false);
    expect(paused.agents).toHaveLength(1);
  });

  it("ignores in-flight import staging directories", () => {
    const managed = managedRepository();
    copyInto(managed, "skills/.skim-import-pending", "fixtures/pinned-skills/algorithmic-art");
    expect(buildRegistryFromDirectory(managed).skills.map((skill) => skill.id)).toEqual(["package-manager-policy"]);
  });
});

describe("registry reads at the managed repository HEAD", () => {
  it("returns the HEAD commit as the shared configuration version", () => {
    const { managed } = importedManagedRepository();
    const head = git(managed, "rev-parse", "HEAD");

    const registry = readRegistry(managed);
    expect(registry.configurationCommit).toBe(head);
    expect(getRegistryResponseSchema.safeParse(registry).success).toBe(true);
    expect(registry.skills.map((skill) => skill.id)).toEqual(["algorithmic-art", "package-manager-policy"]);
    expect(registry.skills[0].source).toMatchObject({ type: "git", license: "Apache-2.0" });
  });

  it("returns identical records for two reads at the same HEAD", () => {
    const { managed } = importedManagedRepository();
    expect(readRegistry(managed)).toEqual(readRegistry(managed));
  });

  it("ignores uncommitted working-tree changes until they are committed", () => {
    const { managed } = importedManagedRepository();
    const before = readRegistry(managed);

    writeFileSync(join(managed, "skills/package-manager-policy/SKILL.md"), "---\nname: package-manager-policy\ndescription: edited.\n---\n\n# Edited\n");
    expect(readRegistry(managed)).toEqual(before);

    const after = commitAll(managed, "edit skill");
    const committed = readRegistry(managed);
    expect(committed.configurationCommit).toBe(after);
    expect(committed.skills[1].description).toBe("edited.");
    expect(committed.skills[1].files[0].hash).not.toBe(before.skills[1].files[0].hash);
  });

  it("reports unusable managed repositories instead of guessing", () => {
    const empty = initRepository(tempDirectory("skim-empty-"));
    expect(() => readRegistry(empty)).toThrow();
    try {
      readRegistry(empty);
    } catch (error) {
      expect(isSkimError(error, "EMPTY_HISTORY")).toBe(true);
    }

    const plain = tempDirectory("skim-plain-");
    try {
      readRegistry(plain);
    } catch (error) {
      expect(isSkimError(error, "NOT_A_GIT_REPOSITORY")).toBe(true);
    }

    const missingAgents = managedRepository();
    rmSync(join(missingAgents, "agents.yaml"));
    commitAll(missingAgents, "remove agents.yaml");
    try {
      readRegistry(missingAgents);
    } catch (error) {
      expect(isSkimError(error, "MISSING_AGENTS_FILE")).toBe(true);
    }

    const brokenAgents = managedRepository();
    writeFileSync(join(brokenAgents, "agents.yaml"), "schemaVersion: 1\nagents:\n  - id: builder\n");
    commitAll(brokenAgents, "break agents.yaml");
    try {
      readRegistry(brokenAgents);
    } catch (error) {
      expect(isSkimError(error, "INVALID_AGENTS_FILE")).toBe(true);
    }

    const brokenLedger = managedRepository();
    materializeRegistry(brokenLedger);
    writeFileSync(join(brokenLedger, ...REGISTRY_FILE.split("/")), "{ not json");
    commitAll(brokenLedger, "break registry.json");
    try {
      readRegistry(brokenLedger);
    } catch (error) {
      expect(isSkimError(error, "INVALID_REGISTRY_FILE")).toBe(true);
    }
  });
});

describe("skill display names", () => {
  it("prefers the first top-level heading and ignores fenced code comments", () => {
    const managed = managedRepository();
    writeFileSync(
      join(managed, "skills/package-manager-policy/SKILL.md"),
      ["---", "name: package-manager-policy", "description: x", "---", "", "```bash", "# pnpm add zod", "```", "", "# Package Manager Policy", ""].join("\n"),
    );
    expect(buildRegistryFromDirectory(managed).skills[0].name).toBe("Package Manager Policy");
  });

  it("falls back to a title-cased slug when there is no heading", () => {
    const managed = managedRepository();
    copyInto(managed, "skills/algorithmic-art", "fixtures/pinned-skills/algorithmic-art");
    expect(buildRegistryFromDirectory(managed).skills.map((skill) => skill.name)).toEqual([
      "Algorithmic Art",
      "Package Manager Policy",
    ]);
  });
});
