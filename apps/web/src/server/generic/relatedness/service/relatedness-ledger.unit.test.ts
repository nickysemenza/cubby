import { describe, expect, it } from "vitest";

import { buildProductRelatednessLedger } from "./relatedness-ledger";

describe("buildProductRelatednessLedger", () => {
  it("deduplicates tag evidence into scored candidates and keeps tags display-only", () => {
    const ledger = buildProductRelatednessLedger(
      [{ id: "PRD-SCORE", title: "Scored", similarity: 0.9 }],
      [
        { shortcode: "PRD-SCORE", name: "Ignored title", tags: ["useful"] },
        { shortcode: "PRD-TAG", name: "Tagged", tags: ["compatible"] },
      ],
      () => true,
    );

    expect(ledger).toEqual([
      expect.objectContaining({
        shortcode: "PRD-SCORE",
        score: 0.9,
        evidence: [
          expect.objectContaining({ signal: "Similar meaning" }),
          expect.objectContaining({ signal: "Shared tag" }),
        ],
      }),
      expect.objectContaining({ shortcode: "PRD-TAG", score: 0 }),
    ]);
  });
});
