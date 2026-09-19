import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandInterceptor, InterceptedCommand } from "./demo-agent";

export type RecordingInterceptor = CommandInterceptor & { readonly commands: InterceptedCommand[] };

export function createRecordingInterceptor(): RecordingInterceptor {
  const commands: InterceptedCommand[] = [];

  const interceptor = async (command: InterceptedCommand) => {
    commands.push(command);

    const manifestPath = join(command.cwd, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
    manifest.dependencies = { ...manifest.dependencies, [command.dependency]: "*" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      join(command.cwd, command.lockfile),
      `# Written by the Skim demo interceptor instead of running: ${command.executable} ${command.arguments.join(" ")}\n`,
    );
  };

  return Object.assign(interceptor, { commands });
}
