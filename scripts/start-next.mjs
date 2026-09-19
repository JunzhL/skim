import { spawn } from "node:child_process";
import { validateRuntimeConfig } from "../src/lib/runtime-config.ts";

const [command, ...args] = process.argv.slice(2);
if (command !== "dev" && command !== "start") {
  console.error("Usage: start-next.mjs <dev|start> [next arguments]");
  process.exit(2);
}

try {
  validateRuntimeConfig(process.env);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Invalid runtime configuration: ${message}`);
  process.exit(1);
}

const child = spawn(process.platform === "win32" ? "next.cmd" : "next", [command, ...args], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
