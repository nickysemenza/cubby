import assert from "node:assert/strict";
import { test } from "node:test";
import { collectRustChecks } from "./check-rust.ts";

test("formatting and Clippy failures do not hide independent Rust test results", () => {
  const ran: string[] = [];
  const failed = collectRustChecks(true, (args) => {
    ran.push(args[0]!);
    return args[0] === "test" ? 0 : 1;
  });
  assert.deepEqual(ran, ["fmt", "clippy", "clippy", "test"]);
  assert.equal(failed, true);
});
