import { format, startOfYear, subDays, subMonths } from "date-fns";
import { describe, expect, it } from "vitest";
import { purchasePresetFilters, resolveDateRange } from "./purchase-options";

describe("resolveDateRange", () => {
  it("returns {} for an undefined preset", () => {
    expect(resolveDateRange(undefined)).toEqual({});
  });

  it("returns {} for an unrecognized preset", () => {
    expect(resolveDateRange("bogus")).toEqual({});
  });

  it("resolves 30d to a 30-day inclusive window ending today", () => {
    const today = new Date();
    const { dateFrom, dateTo } = resolveDateRange("30d");
    expect(dateTo).toBe(format(today, "yyyy-MM-dd"));
    expect(dateFrom).toBe(format(subDays(today, 30), "yyyy-MM-dd"));
  });

  it("resolves 90d to a 90-day inclusive window ending today", () => {
    const today = new Date();
    const { dateFrom, dateTo } = resolveDateRange("90d");
    expect(dateTo).toBe(format(today, "yyyy-MM-dd"));
    expect(dateFrom).toBe(format(subDays(today, 90), "yyyy-MM-dd"));
  });

  it("resolves ytd to the start of the current calendar year", () => {
    const today = new Date();
    const { dateFrom, dateTo } = resolveDateRange("ytd");
    expect(dateTo).toBe(format(today, "yyyy-MM-dd"));
    expect(dateFrom).toBe(format(startOfYear(today), "yyyy-MM-dd"));
  });

  it("resolves 1y to 12 months back", () => {
    const today = new Date();
    const { dateFrom, dateTo } = resolveDateRange("1y");
    expect(dateTo).toBe(format(today, "yyyy-MM-dd"));
    expect(dateFrom).toBe(format(subMonths(today, 12), "yyyy-MM-dd"));
  });
});

describe("purchasePresetFilters", () => {
  it("clears projectId in unassigned mode so the preset can't self-contradict", () => {
    // The bug this pins: `extraFilters` spreads after the manifest's column
    // filters, so a live selection in the project header filter would survive
    // next to `noProject`. buildPurchaseWhereClause then ANDs
    // `projectId IN (…)` with `projectId IS NULL` — unsatisfiable, so the table
    // silently empties. The explicit `projectId: undefined` overrides it away.
    const preset = purchasePresetFilters("unassigned");
    expect(preset.noProject).toBe(true);
    expect(preset.projectId).toBeUndefined();
    expect("projectId" in preset).toBe(true);

    // Prove the override actually wins under the real merge order.
    const merged = { projectId: ["some-project-id"], ...preset };
    expect(merged.projectId).toBeUndefined();
  });

  it("pins the documented preset for each other mode", () => {
    expect(purchasePresetFilters("planned")).toEqual({ future: true });
    expect(purchasePresetFilters("unclassified")).toEqual({
      trade: "other",
      costIsNull: true,
    });
    expect(purchasePresetFilters("ledger")).toEqual({});
  });
});
