import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldRetryRuntime } from "../apps/web/tooling/dev/runtime-retry.ts";

test("only retries an exited, pre-ready address collision within the budget", () => {
  assert.equal(
    shouldRetryRuntime({
      exited: true,
      ready: false,
      cancelled: false,
      logs: "Error: listen EADDRINUSE: address already in use 127.0.0.1:9235",
      attempt: 0,
    }),
    true,
  );
  for (const change of [
    { exited: false },
    { ready: true },
    { cancelled: true },
    { logs: "Worker crashed" },
    { attempt: 3 },
  ]) {
    assert.equal(
      shouldRetryRuntime({
        exited: true,
        ready: false,
        cancelled: false,
        logs: "EADDRINUSE",
        attempt: 0,
        ...change,
      }),
      false,
    );
  }
});
