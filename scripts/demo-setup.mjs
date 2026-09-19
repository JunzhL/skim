import { setupDemoRepository } from "../src/lib/demo-setup.ts";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const destination = separator >= 0 ? args[separator + 1] : args[0];
if (!destination) {
  console.error("Usage: pnpm demo:setup -- <destination>");
  process.exit(2);
}

try {
  const absolutePath = setupDemoRepository(destination, { appRoot: process.cwd() });
  console.log(`Demo repository created at: ${absolutePath}`);
  console.log(`SKIM_REPO_PATH=${absolutePath}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Demo setup failed: ${message}`);
  process.exit(1);
}
