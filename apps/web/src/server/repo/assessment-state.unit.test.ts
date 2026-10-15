import { describe, expect, it } from "vitest";

import { assessmentCandidateKey } from "./assessment-state";

describe("assessmentCandidateKey", () => {
  it("is stable for a versioned positional candidate and differs by kind", async () => {
    await expect(
      assessmentCandidateKey("product.related", ["PRD-ABCD"]),
    ).resolves.toBe(
      await assessmentCandidateKey("product.related", ["PRD-ABCD"]),
    );
    await expect(
      assessmentCandidateKey("product.related", ["PRD-ABCD"]),
    ).resolves.not.toBe(
      await assessmentCandidateKey("product.tag", ["PRD-ABCD"]),
    );
  });
});
