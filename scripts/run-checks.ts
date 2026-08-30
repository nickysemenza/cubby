import concurrently, { type ConcurrentlyCommandInput } from "concurrently";
import { dirname, join } from "node:path";
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
    command:
      "node scripts/entity-literal-generator.ts --check && node scripts/check-browser-route-contracts.ts",
  },
  {
    name: "start-ops",
    command: "node scripts/start-operation-registry-generator.ts --check",
  },
  { name: "types", command: "node scripts/run-typecheck.ts" },
  { name: "lint", command: "oxlint ." },
  { name: "format", command: "oxfmt --check ." },
  { name: "sql", command: "node scripts/check-sql-safety.ts" },
  { name: "soft-delete", command: "node scripts/check-soft-delete-filters.ts" },
  {
    name: "identifiers",
    command:
      "node scripts/check-unsafe-identifiers.ts --include-tests && node --test scripts/check-unsafe-identifiers.unit.test.ts",
  },
  {
    name: "invalidation",
    command: "node scripts/check-invalidation-authority.ts",
  },
  { name: "knip", command: "knip --no-config-hints --cache" },
] as const satisfies readonly CheckTask[];

const allOnlyTasks = [
  { name: "bindings", command: "pnpm types:check" },
  { name: "openapi", command: "pnpm openapi:check" },
  { name: "script-tests", command: "pnpm test:scripts" },
  { name: "security", command: "pnpm audit:security" },
] as const satisfies readonly CheckTask[];

export const maxCheckProcesses = 10;

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
    maxProcesses: maxCheckProcesses,
    prefix: "name",
  });
  await result;
}

if (import.meta.main) {
  try {
    await runChecks(parseCheckMode(process.argv.slice(2)));
  } catch {
    // Each failed command already printed its own diagnostics. Avoid dumping
    // concurrently's command objects, which include the complete environment.
    process.exitCode = 1;
  }
}
