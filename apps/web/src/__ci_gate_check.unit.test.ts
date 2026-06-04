// TEMPORARY — proves the CI gate fails the job on a red test. Removed before merge.
import { expect, it } from "vitest";

it("INTENTIONALLY FAILS to verify CI gating blocks deploy", () => {
  expect(1).toBe(2);
});
