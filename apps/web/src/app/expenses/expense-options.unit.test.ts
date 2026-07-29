import { format, startOfYear, subDays, subMonths } from "date-fns";
import { describe, expect, it } from "vitest";
import { resolveDateRange } from "./expense-options";

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
