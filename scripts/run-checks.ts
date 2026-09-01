import concurrently, { type ConcurrentlyCommandInput } from "concurrently";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export type CheckMode = "fast" | "all";

export type CheckTask = Readonly<{
  name: string;
  command: string;
}>;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Keep check orchestration here rather than in package.json so the task graph
 * is typed, testable, and readable without shell quoting.
 */
const fastTasks = [
  {
    name: "entity",
    command: "node scripts/entity-literal-generator.ts --check",
  },
  {
    name: "start-ops",
    command: "node scripts/start-operation-registry-generator.ts --check",
  },
  { name: "types", command: "node scripts/run-checks.ts typecheck" },
  { name: "lint", command: "oxlint ." },
  { name: "format", command: "oxfmt --check ." },
  { name: "soft-delete", command: "node scripts/check-soft-delete-filters.ts" },
  {
    name: "identifiers",
    command:
      "node scripts/check-unsafe-identifiers.ts --include-tests && node --test scripts/check-unsafe-identifiers.unit.test.ts",
  },
  { name: "knip", command: "knip --no-config-hints --cache" },
] as const satisfies readonly CheckTask[];

const allOnlyTasks = [
  {
    name: "bindings",
    command:
      "pnpm --filter @cubby/web --filter @cubby/upc-lookup --filter @cubby/usda-api --workspace-concurrency=2 types:check",
  },
  {
    name: "openapi",
    command: "pnpm --filter @cubby/usda-api generate:openapi:check",
  },
  { name: "script-tests", command: "pnpm test:scripts" },
  { name: "security", command: "pnpm audit:security" },
] as const satisfies readonly CheckTask[];

export const defaultMaxCheckProcesses = 10;

export function checkProcessLimit(environment = process.env): number {
  const configured = environment.CHECK_MAX_PROCESSES;
  if (!configured) return defaultMaxCheckProcesses;
  const parsed = Number(configured);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > defaultMaxCheckProcesses
  ) {
    throw new Error(
      `CHECK_MAX_PROCESSES must be an integer from 1 to ${defaultMaxCheckProcesses}`,
    );
  }
  return parsed;
}

export function workspaceConcurrency(environment = process.env): number {
  return environment.CI ? 2 : 4;
}

const run = (command: string, arguments_: readonly string[]) => {
  const result = spawnSync(command, arguments_, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

export function runTypecheck() {
  run("pnpm", [
    "-r",
    `--workspace-concurrency=${workspaceConcurrency()}`,
    "typecheck",
  ]);
  run("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"]);
}

export function parseBenchmarkRuns(arguments_: readonly string[]): number {
  if (arguments_.length === 0) return 10;
  const match = /^--runs=(\d+)$/u.exec(arguments_[0] ?? "");
  const runs = match ? Number(match[1]) : Number.NaN;
  if (arguments_.length !== 1 || !Number.isInteger(runs) || runs < 1) {
    throw new Error("benchmark-check: expected --runs=<positive integer>");
  }
  return runs;
}

export function summarizeDurations(durations: readonly number[]) {
  const sorted = durations.toSorted((left, right) => left - right);
  return {
    runs: sorted.length,
    minimum: sorted[0] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    maximum: sorted.at(-1) ?? 0,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

const runBenchmark = (runs: number) => {
  const durations: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const result = spawnSync("pnpm", ["check"], {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const elapsed = (performance.now() - started) / 1000;
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
    durations.push(elapsed);
    process.stdout.write(
      `check ${index + 1}/${runs}: ${elapsed.toFixed(2)}s\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(summarizeDurations(durations), undefined, 2)}\n`,
  );
};

export function getCheckTasks(mode: CheckMode): readonly CheckTask[] {
  return mode === "fast" ? fastTasks : [...fastTasks, ...allOnlyTasks];
}

export function createCheckCommands(
  mode: CheckMode,
): readonly ConcurrentlyCommandInput[] {
  return getCheckTasks(mode).map(({ command, name }) => ({ command, name }));
}

export function parseCheckMode(arguments_: readonly string[]): CheckMode {
  if (arguments_.length === 0) {
    return "fast";
  }
  if (arguments_.length === 1 && arguments_[0] === "--all") {
    return "all";
  }
  throw new Error(`run-checks: unknown arguments: ${arguments_.join(", ")}`);
}

export async function runChecks(mode: CheckMode) {
  await runCheckCommands(createCheckCommands(mode));
}

export async function runCheckCommands(
  commands: readonly ConcurrentlyCommandInput[],
) {
  const { result } = concurrently([...commands], {
    cwd: repoRoot,
    maxProcesses: checkProcessLimit(),
    prefix: "name",
  });
  await result;
}

if (import.meta.main) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length === 1 && arguments_[0] === "typecheck") {
      runTypecheck();
    } else if (arguments_[0] === "benchmark") {
      runBenchmark(parseBenchmarkRuns(arguments_.slice(1)));
    } else {
      await runChecks(parseCheckMode(arguments_));
    }
  } catch {
    // Each failed command already printed its own diagnostics. Avoid dumping
    // concurrently's command objects, which include the complete environment.
    process.exitCode = 1;
  }
}
