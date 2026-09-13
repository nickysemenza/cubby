import { describe, expect, it } from "vitest";

import { assertTestRunContract } from "../../tooling/test-run-contract";

describe("assertTestRunContract", () => {
  it("accepts executed tests without enforcing a fixed total", () => {
    expect(() =>
      assertTestRunContract([
        { name: "passes", state: "passed" },
        { name: "runner reports failures", state: "failed" },
      ]),
    ).not.toThrow();
  });

  it("rejects empty lanes and unexecuted tests", () => {
    expect(() => assertTestRunContract([])).toThrow("discovered no tests");
    expect(() => assertTestRunContract([], { allowEmpty: true })).not.toThrow();
    expect(() =>
      assertTestRunContract([{ name: "focused later", state: "skipped" }]),
    ).toThrow("focused later");
    expect(() =>
      assertTestRunContract([{ name: "never started", state: "pending" }]),
    ).toThrow("never started");
  });
});
