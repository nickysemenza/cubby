import assert from "node:assert/strict";
import test from "node:test";

import { removablePairContainers } from "./test-services.ts";

// Failure modes: every worktree's runs share one pair, so removing a pair a
// live run uses fails that run mid-suite, and matching too broadly deletes the
// dev database, a legacy warm pair, or an unrelated container.
const containers = [
  "cubby-test-aaaaaaaa-postgres",
  "cubby-test-aaaaaaaa-integresql",
  "cubby-test-bbbbbbbb-postgres",
  "cubby-test-bbbbbbbb-integresql",
  "cubby-test-cccccccc-postgres",
  "cubby-dev-pg",
  "cubby-test-pg",
  "cubby-test-integresql",
  "cubby-4242-aabbccdd-postgres",
  "buildkit",
];

test("startup removes only idle pairs of another configuration", () => {
  assert.deepEqual(
    removablePairContainers(
      containers,
      [{ configuration: "bbbbbbbb" }],
      "aaaaaaaa",
    ),
    ["cubby-test-cccccccc-postgres"],
  );
});

test("teardown keeps every pair a live run uses", () => {
  assert.deepEqual(
    removablePairContainers(containers, [{ configuration: "bbbbbbbb" }]),
    [
      "cubby-test-aaaaaaaa-postgres",
      "cubby-test-aaaaaaaa-integresql",
      "cubby-test-cccccccc-postgres",
    ],
  );
});
