import assert from "node:assert/strict";
import test from "node:test";
import {
  createCheckCommands,
  getCheckTasks,
  maxCheckProcesses,
  parseCheckMode,
} from "./run-checks.ts";

test("the fast manifest preserves every existing guard in nine process slots", () => {
  assert.equal(maxCheckProcesses, 9);
  assert.deepEqual(
    getCheckTasks("fast").map(({ name }) => name),
    [
      "entity",
      "start-ops",
      "types",
      "quality",
      "sql",
      "soft-delete",
      "identifiers",
      "invalidation",
      "knip",
    ],
  );
  assert.deepEqual(createCheckCommands("fast")[3], {
    name: "quality",
    command: "pnpm lint && pnpm format:check",
  });
});

test("the all manifest is a flat superset capped by the shared process limit", () => {
  const fast = getCheckTasks("fast");
  const all = getCheckTasks("all");
  assert.deepEqual(all.slice(0, fast.length), fast);
  assert.deepEqual(all.slice(fast.length), [
    { name: "bindings", command: "pnpm types:check" },
    { name: "openapi", command: "pnpm openapi:check" },
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
