import { describe, expect, it } from "vitest";
import { didBatchSettle } from "./background-jobs-page";

describe("background jobs detail refresh", () => {
  it.each([
    ["queued", "succeeded", true],
    ["running", "failed", true],
    ["queued", "running", false],
    ["failed", "queued", false],
    ["succeeded", "succeeded", false],
  ] as const)(
    "detects the %s to %s terminal transition",
    (previous, current, expected) => {
      expect(didBatchSettle(previous, current)).toBe(expected);
    },
  );

  it.each([
    [undefined, "running", false],
    ["running", undefined, false],
    ["running", "partial", true],
    ["running", "cancelled", true],
    ["queued", "queued", false],
    ["failed", "cancelled", false],
  ] as const)(
    "handles the %s to %s boundary",
    (previous, current, expected) => {
      expect(didBatchSettle(previous, current)).toBe(expected);
    },
  );
});
