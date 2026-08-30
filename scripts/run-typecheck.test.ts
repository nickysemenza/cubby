import assert from "node:assert/strict";
import test from "node:test";
import { workspaceConcurrency } from "./run-typecheck.ts";

test("typechecking uses more local concurrency than CI", () => {
  assert.equal(workspaceConcurrency({}), 4);
  assert.equal(workspaceConcurrency({ CI: "true" }), 2);
});
