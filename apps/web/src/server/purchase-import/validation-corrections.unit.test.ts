import type { ValidationPlanLine } from "@cubby/schemas/purchase-import";
import { describe, expect, it } from "vitest";

import {
  compareValidationPlan,
  type LiveValidationLine,
} from "./validation-corrections-compare";

const PRODUCT = "PRD-4K7M";
const OTHER_PRODUCT = "PRD-5K8N";

const planLine = (
  overrides: Partial<ValidationPlanLine> = {},
): ValidationPlanLine => ({
  title: "Widget",
  amount: 10,
  lineKind: "principal",
  quantity: 1,
  productId: PRODUCT,
  ...overrides,
});

const liveLine = (
  code: string,
  overrides: Partial<LiveValidationLine> = {},
): LiveValidationLine => ({
  code,
  title: "Widget",
  amount: 10,
  lineKind: "principal",
  quantity: 1,
  productId: PRODUCT,
  explicitProduct: true,
  ...overrides,
});

const expectedPlan = (
  lines: ValidationPlanLine[],
  overrides: { statedTotal?: number | null; writeBlockReason?: string } = {},
) => ({
  orderId: "ORDER-1",
  currency: "USD",
  statedTotal: overrides.statedTotal === undefined ? 10 : overrides.statedTotal,
  lines,
  writeBlockReason: overrides.writeBlockReason ?? null,
});

const live = (
  lines: LiveValidationLine[],
  statedTotal: number | null = 10,
) => ({
  purchaseCode: "PUR-4K7M",
  orderId: "ORDER-1",
  statedTotal,
  lines,
});

describe("compareValidationPlan", () => {
  it("reports an identical plan as equal with nothing to correct", async () => {
    const result = await compareValidationPlan(
      expectedPlan([planLine()]),
      live([liveLine("EXP-2A3B")]),
    );
    expect(result).toMatchObject({ equal: true, corrections: [], notes: [] });
  });

  it("pairs identical duplicate lines by multiplicity instead of masking a missing copy", async () => {
    const result = await compareValidationPlan(
      expectedPlan([planLine(), planLine()], { statedTotal: 20 }),
      live([liveLine("EXP-2A3B")], 20),
    );
    expect(result.equal).toBe(false);
    expect(result.corrections.map((c) => c.kind)).toEqual(["expense_add"]);
    expect(result.corrections[0]?.after).toMatchObject({ title: "Widget" });
  });

  it("proposes removing the surplus copy of a duplicated live line", async () => {
    const result = await compareValidationPlan(
      expectedPlan([planLine()]),
      live([liveLine("EXP-2A3B"), liveLine("EXP-4C5D")]),
    );
    expect(result.corrections.map((c) => [c.kind, c.target.code])).toEqual([
      ["expense_remove", "EXP-4C5D"],
    ]);
  });

  it("records field-level before/after for a paired line and a changed stated total", async () => {
    const result = await compareValidationPlan(
      expectedPlan([planLine({ amount: 12.5 })], { statedTotal: 12.5 }),
      live([liveLine("EXP-2A3B", { amount: 10 })]),
    );
    const byId = Object.fromEntries(result.corrections.map((c) => [c.id, c]));
    expect(byId["purchase:statedTotal"]).toMatchObject({
      before: 10,
      after: 12.5,
      target: { kind: "purchase", code: "PUR-4K7M" },
    });
    expect(byId["expense:EXP-2A3B:amount"]).toMatchObject({
      before: 10,
      after: 12.5,
    });
  });

  it("pairs a renamed line with the same amount and kind as a title correction", async () => {
    const result = await compareValidationPlan(
      expectedPlan([planLine({ title: "Widget pro" })]),
      live([liveLine("EXP-2A3B")]),
    );
    expect(result.corrections.map((c) => [c.id, c.before, c.after])).toEqual([
      ["expense:EXP-2A3B:title", "Widget", "Widget pro"],
    ]);
  });

  it("is deterministic regardless of live row order", async () => {
    const lines = [
      planLine({ title: "A", amount: 1 }),
      planLine({ title: "B", amount: 2 }),
    ];
    const rows = [
      liveLine("EXP-2A3B", { title: "A", amount: 1.5 }),
      liveLine("EXP-4C5D", { title: "B", amount: 2.5 }),
    ];
    const forward = await compareValidationPlan(
      expectedPlan(lines, { statedTotal: 3 }),
      live(rows, 3),
    );
    const reversed = await compareValidationPlan(
      expectedPlan([...lines].reverse(), { statedTotal: 3 }),
      live([...rows].reverse(), 3),
    );
    expect(reversed.corrections).toEqual(forward.corrections);
  });

  it("never proposes changing an explicit Product; the disagreement is a note", async () => {
    const result = await compareValidationPlan(
      expectedPlan([planLine({ productId: OTHER_PRODUCT })]),
      live([liveLine("EXP-2A3B", { productId: PRODUCT })]),
    );
    expect(result.equal).toBe(false);
    expect(result.corrections).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      field: "productId",
      before: PRODUCT,
      after: OTHER_PRODUCT,
    });
  });

  it("offers a productId correction only when the live line has no Product and the plan names an existing one", async () => {
    const result = await compareValidationPlan(
      expectedPlan([planLine()]),
      live([
        liveLine("EXP-2A3B", {
          productId: null,
          explicitProduct: false,
          quantity: null,
        }),
      ]),
    );
    expect(result.corrections.map((c) => c.id).sort()).toEqual([
      "expense:EXP-2A3B:productId",
      "expense:EXP-2A3B:quantity",
    ]);
    const unresolved = await compareValidationPlan(
      expectedPlan([planLine({ productId: "new" })]),
      live([
        liveLine("EXP-2A3B", {
          productId: null,
          explicitProduct: false,
          quantity: 1,
        }),
      ]),
    );
    expect(unresolved.corrections).toEqual([]);
    expect(unresolved.notes.map((n) => n.field)).toContain("productId");
  });

  it("offers no corrections when the plan is write-blocked (foreign currency)", async () => {
    const result = await compareValidationPlan(
      {
        ...expectedPlan([planLine({ amount: 99 })], {
          writeBlockReason: "foreign_currency",
        }),
        currency: "EUR",
      },
      live([liveLine("EXP-2A3B")]),
    );
    expect(result.equal).toBe(false);
    expect(result.corrections).toEqual([]);
    expect(result.notes[0]?.message).toContain("foreign_currency");
  });

  it("changes a fingerprint when the compared live values change but not otherwise", async () => {
    const plan = expectedPlan([planLine({ amount: 11 })], { statedTotal: 11 });
    const first = await compareValidationPlan(
      plan,
      live([liveLine("EXP-2A3B")]),
    );
    const again = await compareValidationPlan(
      plan,
      live([liveLine("EXP-2A3B")]),
    );
    const edited = await compareValidationPlan(
      plan,
      live([liveLine("EXP-2A3B", { title: "Renamed elsewhere" })]),
    );
    const amountId = "expense:EXP-2A3B:amount";
    const pick = (r: typeof first) =>
      r.corrections.find((c) => c.id === amountId)?.fingerprint;
    expect(pick(again)).toBe(pick(first));
    expect(pick(edited)).not.toBe(pick(first));
  });
});
