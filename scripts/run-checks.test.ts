import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckCommands,
  getCheckTasks,
  maxCheckProcesses,
  parseBenchmarkRuns,
  parseCheckMode,
  runCheckCommands,
  summarizeDurations,
  workspaceConcurrency,
} from "./run-checks.ts";

test("typecheck uses local parallelism without oversubscribing CI", () => {
  assert.equal(workspaceConcurrency({}), 4);
  assert.equal(workspaceConcurrency({ CI: "true" }), 2);
});

test("the check benchmark defaults to ten runs and validates overrides", () => {
  assert.equal(parseBenchmarkRuns([]), 10);
  assert.equal(parseBenchmarkRuns(["--runs=3"]), 3);
  assert.throws(() => parseBenchmarkRuns(["--runs=0"]), /positive integer/u);
  assert.throws(() => parseBenchmarkRuns(["3"]), /positive integer/u);
});

test("duration summaries are deterministic", () => {
  assert.deepEqual(summarizeDurations([3, 1, 2]), {
    runs: 3,
    minimum: 1,
    median: 2,
    maximum: 3,
    mean: 2,
  });
});

test("the fast manifest preserves every guard and runs lint and format separately", () => {
  assert.equal(maxCheckProcesses, 10);
  assert.deepEqual(
    getCheckTasks("fast").map(({ name }) => name),
    [
      "entity",
      "start-ops",
      "types",
      "lint",
      "format",
      "soft-delete",
      "identifiers",
      "knip",
    ],
  );
  assert.deepEqual(createCheckCommands("fast").slice(3, 5), [
    { name: "lint", command: "oxlint ." },
    { name: "format", command: "oxfmt --check ." },
  ]);
});

test("the all manifest is a flat superset capped by the shared process limit", () => {
  const fast = getCheckTasks("fast");
  const all = getCheckTasks("all");
  assert.deepEqual(all.slice(0, fast.length), fast);
  assert.deepEqual(all.slice(fast.length), [
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
  ]);
  assert.equal(new Set(all.map(({ name }) => name)).size, all.length);
});

test("only --all opts into the complete manifest", () => {
  assert.equal(parseCheckMode([]), "fast");
  assert.equal(parseCheckMode(["--all"]), "all");
  assert.throws(() => parseCheckMode(["--fast"]), /unknown arguments/);
});

test("every fast failure class propagates without cancelling peer diagnostics", async () => {
  for (const { name } of getCheckTasks("fast")) {
    const marker = `${name}-peer-completed`;
    await assert.rejects(
      runCheckCommands([
        {
          name,
          command: 'node -e "process.exit(7)"',
        },
        {
          name: `${name}-peer`,
          command: `node -e 'process.stdout.write("${marker}")'`,
        },
      ]),
      name,
    );
  }
});
