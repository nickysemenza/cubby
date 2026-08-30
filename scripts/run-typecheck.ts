import { spawnSync } from "node:child_process";

export function workspaceConcurrency(environment = process.env): number {
  return environment.CI ? 2 : 4;
}

function run(command: string, arguments_: readonly string[]) {
  const result = spawnSync(command, arguments_, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.main) {
  run("pnpm", [
    "-r",
    `--workspace-concurrency=${workspaceConcurrency()}`,
    "typecheck",
  ]);
  run("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"]);
}
