import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The integration tests drive real Git fetches, worktrees, and commits. Vitest's
    // 5s default is below what a single preview round-trip costs on a cold cache.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
