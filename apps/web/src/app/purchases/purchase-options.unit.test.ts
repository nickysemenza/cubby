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
  it("pins projectPresenceFilter: none in unassigned mode, with no projectId clobber", () => {
    // Used to also clear `projectId: undefined` here: `noProject` ANDed with a
    // live project-column selection produced `projectId IN (…) AND projectId
    // IS NULL`, an unsatisfiable contradiction that silently emptied the
    // table. Presence now ORs with the selection instead, so a project pick
    // on this tab *widens* it ("unassigned or Kitchen") rather than emptying
    // it — the clobber would discard the user's selection, which is worse.
    const preset = purchasePresetFilters("unassigned");
    expect(preset).toEqual({ projectPresenceFilter: "none" });
    expect("projectId" in preset).toBe(false);
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
