import { describe, expect, it } from "vitest";
import { suggestionCandidateKey } from "./suggestion-dismissal";

describe("suggestionCandidateKey", () => {
  it("is stable for a versioned positional candidate and differs by kind", async () => {
    await expect(
      suggestionCandidateKey("product.related", ["PRD-ABCD"]),
    ).resolves.toBe(
      await suggestionCandidateKey("product.related", ["PRD-ABCD"]),
    );
    await expect(
      suggestionCandidateKey("product.related", ["PRD-ABCD"]),
    ).resolves.not.toBe(
      await suggestionCandidateKey("product.tag", ["PRD-ABCD"]),
    );
  });
});
