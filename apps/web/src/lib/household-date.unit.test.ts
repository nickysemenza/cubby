import { describe, expect, it } from "vitest";

import {
  householdDateTime,
  householdDaysAgo,
  householdDaysFromNow,
  householdLocalDate,
} from "./household-date";

describe("household calendar dates", () => {
  it("changes date at household midnight rather than UTC midnight", () => {
    expect(householdLocalDate(new Date("2026-08-18T06:59:59Z"))).toBe(
      "2026-08-17",
    );
    expect(householdLocalDate(new Date("2026-08-18T07:00:00Z"))).toBe(
      "2026-08-18",
    );
  });

  it("shifts calendar days across the spring DST boundary", () => {
    const justAfterMidnight = new Date("2026-03-09T07:30:00Z");
    expect(householdLocalDate(justAfterMidnight)).toBe("2026-03-09");
    expect(householdDaysAgo(1, justAfterMidnight)).toBe("2026-03-08");
  });

  it("shifts calendar days across the fall DST boundary", () => {
    const justAfterMidnight = new Date("2026-11-02T08:30:00Z");
    expect(householdLocalDate(justAfterMidnight)).toBe("2026-11-02");
    expect(householdDaysAgo(1, justAfterMidnight)).toBe("2026-11-01");
    expect(householdDaysFromNow(1, justAfterMidnight)).toBe("2026-11-03");
  });
});

describe("householdDateTime", () => {
  it("resolves a wall time against the offset in force on that date", () => {
    // 7pm dinner. August is PDT (UTC-7), January is PST (UTC-8) — a hardcoded
    // offset would be wrong for half of every published feed window.
    expect(householdDateTime("2026-08-15", 19 * 60).toISOString()).toBe(
      "2026-08-16T02:00:00.000Z",
    );
    expect(householdDateTime("2026-01-15", 19 * 60).toISOString()).toBe(
      "2026-01-16T03:00:00.000Z",
    );
  });

  it("defaults to household midnight", () => {
    expect(householdDateTime("2026-08-15").toISOString()).toBe(
      "2026-08-15T07:00:00.000Z",
    );
  });

  it("serializes as UTC, not as the household offset", () => {
    // The ICS feed appends a literal "Z"; a TZDate leaking through would
    // render "…-07:00" and label a 7pm dinner as noon.
    expect(householdDateTime("2026-08-15", 9 * 60).toISOString()).toMatch(/Z$/);
  });

  it("rejects a value that is not a plain date", () => {
    expect(() => householdDateTime("2026-08")).toThrow(/plain date/);
  });
});
