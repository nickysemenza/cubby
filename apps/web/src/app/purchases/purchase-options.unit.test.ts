import { format, startOfYear, subDays, subMonths } from "date-fns";
import { describe, expect, it } from "vitest";
import {
  buildPurchaseFilters,
  resolveDateRange,
  UNASSIGNED_PROJECT_FILTER,
} from "./purchase-options";

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

describe("buildPurchaseFilters — project vs unassigned", () => {
  const build = (project: string | undefined) =>
    buildPurchaseFilters((id) => (id === "project" ? project : undefined));

  it("maps the unassigned sentinel to noProject, not projectId", () => {
    // The sentinel must never be branded into a projectId — that would query
    // for a project whose id is literally "__unassigned__" and return nothing.
    const filters = build(UNASSIGNED_PROJECT_FILTER);
    expect(filters.noProject).toBe(true);
    expect(filters.projectId).toBeUndefined();
  });

  it("maps a real project id to projectId and leaves noProject unset", () => {
    const filters = build("11111111-1111-4111-8111-111111111111");
    expect(filters.projectId).toBe("11111111-1111-4111-8111-111111111111");
    expect(filters.noProject).toBeUndefined();
  });

  it("treats an empty/absent project filter as no constraint at all", () => {
    for (const value of ["", undefined]) {
      const filters = build(value);
      expect(filters.projectId).toBeUndefined();
      expect(filters.noProject).toBeUndefined();
    }
  });
});
