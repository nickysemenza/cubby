import assert from "node:assert/strict";
import test from "node:test";
import { parseRuns, summarizeDurations } from "./benchmark-check.ts";

test("the check benchmark defaults to ten runs and validates overrides", () => {
  assert.equal(parseRuns([]), 10);
  assert.equal(parseRuns(["--runs=3"]), 3);
  assert.throws(() => parseRuns(["--runs=0"]), /positive integer/);
  assert.throws(() => parseRuns(["3"]), /positive integer/);
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
