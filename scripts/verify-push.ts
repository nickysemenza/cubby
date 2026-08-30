import { spawnSync } from "node:child_process";
import { classifyPaths } from "./ci-scope.ts";

export type PushCheck =
  | "web-tests"
  | "postgres"
  | "e2e"
  | "cloudflare"
  | "aux"
  | "rust";

export function selectPushChecks(
  paths: readonly string[],
): readonly PushCheck[] {
  const scope = classifyPaths(paths);
  if (scope.inert) return [];

  return [
    ...(scope.web
      ? ([scope.postgres ? "postgres" : "web-tests"] as const)
      : []),
    ...(scope.e2e || scope.highRisk ? (["e2e"] as const) : []),
    ...(scope.cloudflare ? (["cloudflare"] as const) : []),
    ...(scope.aux ? (["aux"] as const) : []),
    ...(scope.rust ? (["rust"] as const) : []),
  ];
}

function capture(command: string, arguments_: readonly string[]): string {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `${command} exited ${result.status}`,
    );
  }
  return result.stdout.trim();
}

function resolveBase(): string {
  if (process.env.CUBBY_VERIFY_BASE) return process.env.CUBBY_VERIFY_BASE;
  try {
    return capture("git", ["merge-base", "HEAD", "origin/main"]);
  } catch {
    return capture("git", ["rev-parse", "HEAD^"]);
  }
}

function run(command: string, arguments_: readonly string[]) {
  const display = [command, ...arguments_].join(" ");
  process.stdout.write(`\n[pre-push] ${display}\n`);
  const result = spawnSync(command, arguments_, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.main) {
  const base = resolveBase();
  const paths = capture("git", [
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    `${base}...HEAD`,
  ])
    .split("\n")
    .filter(Boolean);
  const checks = selectPushChecks(paths);

  if (checks.length === 0) {
    process.stdout.write(
      "[pre-push] No code changes require scoped verification.\n",
    );
    process.exit(0);
  }

  process.stdout.write(
    `[pre-push] ${paths.length} changed paths from ${base}; running ${checks.join(", ")}.\n`,
  );

  for (const check of checks) {
    if (check === "web-tests") run("pnpm", ["test:changed", base]);
    if (check === "postgres") run("pnpm", ["test:changed:postgres", base]);
    if (check === "e2e") run("pnpm", ["test:e2e"]);
    if (check === "cloudflare")
      run("pnpm", ["--filter", "@cubby/web", "run", "build:cf"]);
    if (check === "aux")
      run("pnpm", [
        "-r",
        "--no-sort",
        "--workspace-concurrency=4",
        "--no-bail",
        "--filter",
        "!@cubby/web",
        "--if-present",
        "run",
        "test",
      ]);
    if (check === "rust") {
      run("cargo", [
        "fmt",
        "--manifest-path",
        "recipebridge/Cargo.toml",
        "--check",
      ]);
      run("cargo", [
        "clippy",
        "--manifest-path",
        "recipebridge/Cargo.toml",
        "--all-targets",
        "--",
        "-D",
        "warnings",
      ]);
      run("cargo", ["test", "--manifest-path", "recipebridge/Cargo.toml"]);
    }
  }
}
