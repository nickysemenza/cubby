import { describe, expect, it } from "vitest";

import { buildRelatednessLedger } from "./relatedness-ledger";

describe("buildRelatednessLedger", () => {
  it("deduplicates tag evidence into scored candidates and keeps tags display-only", () => {
    const ledger = buildRelatednessLedger("recipe", [
      {
        shortcode: "RCP-SCORE",
        title: "Scored",
        score: 0.9,
        evidence: [{ signal: "Similar meaning", detail: null, weight: 0.9 }],
      },
      {
        shortcode: "RCP-SCORE",
        title: "Ignored title",
        score: 0,
        evidence: [{ signal: "Shared tag", detail: "useful", weight: 0 }],
      },
      {
        shortcode: "RCP-TAG",
        title: "Tagged",
        score: 0,
        evidence: [{ signal: "Shared tag", detail: "compatible", weight: 0 }],
      },
    ]);

    expect(ledger).toEqual([
      expect.objectContaining({
        shortcode: "RCP-SCORE",
        score: 0.9,
        evidence: [
          expect.objectContaining({ signal: "Similar meaning" }),
          expect.objectContaining({ signal: "Shared tag" }),
        ],
      }),
      expect.objectContaining({ shortcode: "RCP-TAG", score: 0 }),
    ]);
  });
});
