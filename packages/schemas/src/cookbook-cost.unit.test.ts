import { describe, expect, it } from "vitest";
import { normalizeCookbookCostReport } from "./cookbook";

describe("legacy cookbook accounting", () => {
  it("keeps an empty recorded call population empty", () => {
    expect(
      normalizeCookbookCostReport({
        total_cost_usd: 0,
        cost_complete: true,
        calls: [],
        usage_by_model: [],
      }),
    ).toMatchObject({
      count: 0,
      standardUnpricedCount: 0,
      chargedUnpricedCount: 0,
      comparedCalls: 0,
      calls: [],
      standardComplete: true,
      chargedComplete: true,
    });
  });
});

it("retains aggregate coverage uncertainty without fictional calls", () => {
  expect(
    normalizeCookbookCostReport({
      total_cost_usd: 0.5,
      cost_complete: false,
      calls: [],
      usage_by_model: [],
    }),
  ).toMatchObject({
    count: 0,
    chargedCost: 0.5,
    standardComplete: false,
    chargedComplete: false,
    costEvidence: { original: { estimatedCost: 0.5, chargedComplete: false } },
  });
});

it("labels fresh extractor estimates independently of stored historical reports", () => {
  const report = {
    total_cost_usd: 0.5,
    cost_complete: true,
    calls: [{ cost_usd: 0.5 }],
    usage_by_model: [],
  };
  expect(normalizeCookbookCostReport(report)).toMatchObject({
    costEvidence: { charged: { source: "historical_recorded" } },
    calls: [{ costEvidence: { charged: { source: "historical_recorded" } } }],
  });
  expect(normalizeCookbookCostReport(report, "estimate")).toMatchObject({
    costEvidence: { charged: { source: "estimate", pricingSource: "caller" } },
    calls: [
      {
        costEvidence: {
          charged: { source: "estimate", pricingSource: "caller" },
        },
      },
    ],
  });
});
