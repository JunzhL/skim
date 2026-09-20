import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { validateRuntimeConfig } from "../src/lib/runtime-config.ts";

const [command, ...args] = process.argv.slice(2);
if (command !== "dev" && command !== "start") {
  console.error("Usage: start-next.mjs <dev|start> [next arguments]");
  process.exit(2);
}

// Next.js loads these files itself, but only inside the child process. Validation
// runs first, so the wrapper has to load them too. process.loadEnvFile never
// overwrites a variable that is already set, so the real environment wins and the
// files keep Next's own precedence order.
const mode = command === "dev" ? "development" : "production";
for (const file of [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"]) {
  try {
    process.loadEnvFile(resolve(process.cwd(), file));
  } catch (error) {
    if (error.code === "ENOENT") continue;
    console.error(`Could not read ${file}: ${error.message}`);
    process.exit(1);
  }
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

let shutdownSignal;
let forceExitTimer;

function forwardShutdownSignal(signal) {
  if (shutdownSignal) return;
  shutdownSignal = signal;
  child.kill(signal);
  forceExitTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  forceExitTimer.unref();
}

process.once("SIGINT", () => forwardShutdownSignal("SIGINT"));
process.once("SIGTERM", () => forwardShutdownSignal("SIGTERM"));

child.on("error", (error) => {
  console.error(`Failed to start Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (forceExitTimer) clearTimeout(forceExitTimer);
  if (shutdownSignal) {
    process.exitCode = 0;
    return;
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
