import { describe, expect, it } from "vitest";

import { fieldDecisionRows } from "./field-decisions";
import { fieldPolicyFingerprint } from "./refresh-manifest";

// Failure mode: a review-policy-only change leaves the deployed fingerprint
// unchanged, so already applied logical targets never get reevaluated.
describe("field refresh policy fingerprints", () => {
  it("invalidates field work when declared review or assignment mode changes", async () => {
    const row = fieldDecisionRows().find(
      (candidate) =>
        candidate.entity === "product" && candidate.field === "categoryId",
    );
    if (!row) throw new Error("Synthetic category policy is unavailable");
    const ordinary = await fieldPolicyFingerprint({
      ...row,
      reviewRequired: false,
    });
    expect(
      await fieldPolicyFingerprint({ ...row, reviewRequired: true }),
    ).not.toBe(ordinary);
    expect(
      await fieldPolicyFingerprint({
        ...row,
        mode: "prune",
        reviewRequired: false,
      }),
    ).not.toBe(ordinary);
  });
});
