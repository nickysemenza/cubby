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
});
