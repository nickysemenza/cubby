import { describe, expect, it } from "vitest";
import {
  type ExpenseLineKindBackfillRow,
  planExpenseLineKindBackfill,
} from "./line-kind-backfill";

const row = (
  shortcode: string,
  name: string,
  overrides: Partial<ExpenseLineKindBackfillRow> = {},
): ExpenseLineKindBackfillRow => ({
  id: `uuid-${shortcode}`,
  shortcode,
  name,
  lineKind: "principal",
  productId: null,
  deletedAt: null,
  ...overrides,
});

describe("planExpenseLineKindBackfill", () => {
  it("classifies high-confidence rows and reports ambiguous names", () => {
    const plan = planExpenseLineKindBackfill([
      row("EXP-TAX1", "Sales tax"),
      row("EXP-SHIP", "Shipping and handling"),
      row("EXP-DISC", "Order discount"),
      row("EXP-FEE1", "Processing fee"),
      row("EXP-TIP1", "Tip"),
      row("EXP-COMB", "Order tax, shipping, and fee"),
      row("EXP-AMB1", "Shipping packing tape"),
      row("EXP-NONE", "Cordless drill"),
    ]);

    expect(plan.candidates.map(({ shortcode, to }) => [shortcode, to])).toEqual(
      [
        ["EXP-COMB", "other_adjustment"],
        ["EXP-DISC", "discount"],
        ["EXP-FEE1", "fee"],
        ["EXP-SHIP", "shipping"],
        ["EXP-TAX1", "tax"],
        ["EXP-TIP1", "tip"],
      ],
    );
    expect(plan.ambiguous).toEqual([
      {
        shortcode: "EXP-AMB1",
        name: "Shipping packing tape",
        hintedKinds: ["shipping"],
      },
    ]);
    expect(plan.unchanged).toEqual([
      { shortcode: "EXP-NONE", name: "Cordless drill" },
    ]);
  });

  it("is product-safe and idempotent", () => {
    const input = [
      row("EXP-PROD", "Sales tax", { productId: "product-uuid" }),
      row("EXP-DONE", "Sales tax", { lineKind: "tax" }),
      row("EXP-LIVE", "Sales tax"),
      row("EXP-DEAD", "Sales tax", { deletedAt: "2026-01-01" }),
    ];
    const first = planExpenseLineKindBackfill(input);
    expect(first.candidates.map((candidate) => candidate.shortcode)).toEqual([
      "EXP-LIVE",
    ]);
    expect(first.skipped.map((item) => item.reason).sort()).toEqual([
      "already_classified",
      "deleted",
      "product_linked",
    ]);

    const applied = input.map((item) =>
      item.shortcode === "EXP-LIVE"
        ? { ...item, lineKind: "tax" as const }
        : item,
    );
    expect(planExpenseLineKindBackfill(applied).candidates).toEqual([]);
  });
});
