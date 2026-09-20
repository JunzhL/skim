#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialiseManagedRepository } from "../dist/init.js";
import { validateRuntimeConfig } from "../dist/runtime-config.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `skimctl — review agent skill changes as Git transactions

Usage
  skimctl [start] [--port <n>] [--repo <path>]   Serve the dashboard for a repository
  skimctl init [--repo <path>]                   Create agents.yaml and skills/ in a repository
  skimctl --help

The repository defaults to the Git root of the current directory. SKIM_REPO_PATH overrides it,
and .env.local in the repository supplies the conflict-analysis provider credentials.
`;

function parseArguments(argv) {
  const options = { command: "start", port: process.env.PORT ?? "3000", repo: undefined, help: false };
  const rest = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--port" || argument === "-p") options.port = argv[++index];
    else if (argument === "--repo") options.repo = argv[++index];
    else if (index === 0 && !argument.startsWith("-")) options.command = argument;
    else rest.push(argument);
  }
  return { ...options, rest };
}

function resolveRepository(requested) {
  if (requested) return resolve(requested);
  if (process.env.SKIM_REPO_PATH) return resolve(process.env.SKIM_REPO_PATH);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    fail("Not inside a Git repository. Run skimctl from a repository, or pass --repo <path>.");
  }
}

function fail(message) {
  console.error(`skimctl: ${message}`);
  process.exit(1);
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(USAGE);
  process.exit(0);
}

const repository = resolveRepository(options.repo);

if (options.command === "init") {
  try {
    const { created, skipped } = initialiseManagedRepository(repository);
    for (const path of created) console.log(`created  ${path}`);
    for (const path of skipped) console.log(`exists   ${path}`);
    console.log(`\nSkill Manager is ready for ${repository}.\nCommit these files, then run: skimctl`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  process.exit(0);
}

if (options.command !== "start") fail(`Unknown command: ${options.command}\n\n${USAGE}`);

// The dashboard reads provider credentials from the managed repository, not from the package.
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(resolve(repository, file));
  } catch (error) {
    if (error.code !== "ENOENT") fail(`Could not read ${file}: ${error.message}`);
  }
}
process.env.SKIM_REPO_PATH = repository;

try {
  validateRuntimeConfig(process.env, { appRoot: PACKAGE_ROOT });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/agents\.yaml|SKIM_REPO_PATH/.test(message)) {
    fail(`${message}\n\nIf this repository has not been set up yet, run: skimctl init`);
  }
  fail(message);
}

if (!existsSync(resolve(repository, "agents.yaml"))) {
  fail(`${repository} has no agents.yaml. Run: skimctl init`);
}

// Resolve Next through the module graph rather than a .bin path: package managers hoist
// differently, so node_modules/.bin/next is not reliably next to this package.
let nextBin;
try {
  const require = createRequire(import.meta.url);
  nextBin = resolve(dirname(require.resolve("next/package.json")), "dist/bin/next");
} catch {
  fail("Could not find the next package. Reinstall skimctl.");
}
if (!existsSync(nextBin)) fail(`The bundled dashboard server is missing at ${nextBin}. Reinstall skimctl.`);

if (!existsSync(resolve(PACKAGE_ROOT, ".next"))) {
  fail("This copy of skimctl has no built dashboard (.next is missing). Reinstall from npm.");
}

const child = spawn(process.execPath, [nextBin, "start", "--port", String(options.port)], {
  cwd: PACKAGE_ROOT,
  stdio: "inherit",
  env: process.env,
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    child.kill(signal);
  });
}

child.on("error", (error) => fail(`Could not start the dashboard: ${error.message}`));
child.on("exit", (code) => process.exit(shuttingDown ? 0 : (code ?? 1)));
