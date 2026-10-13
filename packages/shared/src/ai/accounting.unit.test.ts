import { describe, expect, it } from "vitest";
import { accountAiUsage } from "./pricing";

describe("accountAiUsage", () => {
  it("preserves independent plan and cache comparison evidence", () => {
    const standard = {
      amount: 0.003,
      evidence: { source: "estimate" as const },
    };
    expect(
      accountAiUsage(standard, { billingReason: "plan" }, { inputTokens: 10 }),
    ).toMatchObject({
      standardCost: 0.003,
      chargedCost: 0,
      costEvidence: { billingReason: "plan" },
    });
    expect(
      accountAiUsage(
        { amount: null, evidence: null },
        { billingReason: "cache" },
        {},
      ),
    ).toMatchObject({ standardCost: null, chargedCost: 0 });
  });
  it("uses explicitly supplied discount rates and compares only known costs", () => {
    expect(
      accountAiUsage(
        { amount: 0.01, evidence: { source: "estimate" } },
        {
          billingReason: "discount",
          adjustment: { rates: { input: 1, output: 2 } },
        },
        { inputTokens: 1000, outputTokens: 1000 },
      ),
    ).toMatchObject({
      standardCost: 0.01,
      chargedCost: 0.003,
      costEvidence: {
        billingReason: "discount",
        adjustment: { rates: { input: 1, output: 2 } },
      },
    });
    expect(
      accountAiUsage(
        { amount: null, evidence: null },
        { billingReason: "standard" },
        {},
      ),
    ).toMatchObject({ standardCost: null, chargedCost: null });
  });
});

it("applies explicit discounts ahead of a nominal SDK charge estimate", () => {
  const standard = { amount: 0.01, evidence: { source: "estimate" as const } };
  const billing = {
    billingReason: "discount" as const,
    chargedCost: 0.01,
    charged: { source: "estimate" as const, pricingSource: "pi_sdk" as const },
  };
  const usage = { inputTokens: 1000, outputTokens: 1000 };
  expect(
    accountAiUsage(
      standard,
      { ...billing, adjustment: { chargedAmount: 0.002 } },
      usage,
    ),
  ).toMatchObject({
    chargedCost: 0.002,
    costEvidence: { charged: { source: "estimate", pricingSource: "caller" } },
  });
  expect(
    accountAiUsage(
      standard,
      { ...billing, adjustment: { rates: { input: 1, output: 2 } } },
      usage,
    ),
  ).toMatchObject({
    chargedCost: 0.003,
    costEvidence: { charged: { source: "estimate", pricingSource: "caller" } },
  });
  expect(
    accountAiUsage(
      standard,
      {
        ...billing,
        chargedCost: 0.007,
        charged: { source: "provider_reported" },
        adjustment: { rates: { input: 1, output: 2 } },
      },
      usage,
    ),
  ).toMatchObject({
    chargedCost: 0.007,
    costEvidence: { charged: { source: "provider_reported" } },
  });
});
