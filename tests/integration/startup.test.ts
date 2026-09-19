import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("startup wrapper", () => {
  it("exits before launching Next.js when managed-repository validation fails", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/start-next.mjs", "dev"],
      {
        cwd: process.cwd(),
        env: { ...process.env, SKIM_REPO_PATH: "" },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid runtime configuration");
    expect(result.stderr).toContain("SKIM_REPO_PATH");
    expect(result.stdout).not.toContain("Next.js");
  });
});
