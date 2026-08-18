import { describe, expect, it } from "vitest";
import {
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
