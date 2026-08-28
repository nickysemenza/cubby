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
  { name: "entity", command: "pnpm entity:check" },
  { name: "start-ops", command: "pnpm start-operations:check" },
  { name: "types", command: "pnpm typecheck" },
  // Oxlint and Oxfmt are both full-tree checks; running them together keeps
  // the existing nine-process fast gate while making both checks mandatory.
  { name: "quality", command: "pnpm lint && pnpm format:check" },
  { name: "sql", command: "node scripts/check-sql-safety.ts" },
  { name: "soft-delete", command: "node scripts/check-soft-delete-filters.ts" },
  { name: "identifiers", command: "pnpm unsafe-identifiers:check" },
  {
    name: "invalidation",
    command: "node scripts/check-invalidation-authority.ts",
  },
  { name: "knip", command: "pnpm knip" },
] as const satisfies readonly CheckTask[];

const allOnlyTasks = [
  { name: "bindings", command: "pnpm types:check" },
  { name: "openapi", command: "pnpm openapi:check" },
  { name: "script-tests", command: "pnpm test:scripts" },
  { name: "security", command: "pnpm audit:security" },
] as const satisfies readonly CheckTask[];

export const maxCheckProcesses = 9;

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
  const { result } = concurrently([...createCheckCommands(mode)], {
    cwd: repoRoot,
    killOthersOn: ["failure"],
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
