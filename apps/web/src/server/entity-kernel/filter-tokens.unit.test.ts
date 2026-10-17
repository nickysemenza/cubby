import { locationFiltersSchema } from "@cubby/schemas/location";
import { taskFiltersSchema } from "@cubby/schemas/project";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { resolveRelativeDateFilters } from "./filter-tokens";

/**
 * Relative date tokens (#2415). Failure modes: resolving against the UTC day
 * (a Worker's clock) instead of the household's, so `@today` is tomorrow
 * after ~4pm PT; day arithmetic that crosses a DST or month boundary on an
 * instant; rewriting a search that merely contains "@today"; and a nested
 * `filters` object (an analyze or Problem input) left unresolved.
 */
describe("resolveRelativeDateFilters", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves @today to the household day, not the UTC day", () => {
    vi.useFakeTimers();
    // 23:59 PST on Jan 14 is already Jan 15 in UTC.
    vi.setSystemTime(new Date("2026-01-15T07:59:00Z"));
    expect(
      resolveRelativeDateFilters(taskFiltersSchema, { dueTo: "@today" }),
    ).toEqual({ dueTo: "2026-01-14" });
    vi.setSystemTime(new Date("2026-01-15T08:00:00Z"));
    expect(
      resolveRelativeDateFilters(taskFiltersSchema, { dueTo: "@today" }),
    ).toEqual({ dueTo: "2026-01-15" });
  });

  it("shifts whole calendar days across DST, month and year boundaries", () => {
    const resolve = (value: string, today: string) =>
      resolveRelativeDateFilters(taskFiltersSchema, { dueFrom: value }, today)
        .dueFrom;
    expect(resolve("@today-1d", "2026-03-09")).toBe("2026-03-08");
    expect(resolve("@today+1d", "2026-11-01")).toBe("2026-11-02");
    expect(resolve("@today-30d", "2026-03-01")).toBe("2026-01-30");
    expect(resolve("@today+1d", "2026-12-31")).toBe("2027-01-01");
    expect(resolve("2026-05-01", "2026-12-31")).toBe("2026-05-01");
  });

  it("reads a later day for the same saved filters", () => {
    const saved = {
      lastBulkInventoryTo: "@today-30d",
      lastBulkInventoryPresenceFilter: "none" as const,
    };
    expect(
      resolveRelativeDateFilters(locationFiltersSchema, saved, "2026-06-30"),
    ).toEqual({ ...saved, lastBulkInventoryTo: "2026-05-31" });
    expect(
      resolveRelativeDateFilters(locationFiltersSchema, saved, "2026-07-01"),
    ).toEqual({ ...saved, lastBulkInventoryTo: "2026-06-01" });
  });

  it("leaves text that contains a token alone and resolves nested filters", () => {
    const schema = z.object({
      search: z.string().optional(),
      filters: taskFiltersSchema.optional(),
    });
    expect(
      resolveRelativeDateFilters(
        schema,
        { search: "@today", filters: { dueTo: "@today-1d" } },
        "2026-05-12",
      ),
    ).toEqual({ search: "@today", filters: { dueTo: "2026-05-11" } });
  });

  it("rejects a malformed token at the schema", () => {
    for (const dueTo of ["@today-3w", "@tomorrow", "@today-", "today"])
      expect(taskFiltersSchema.safeParse({ dueTo }).success).toBe(false);
    for (const dueTo of ["@today", "@today-1d", "@today+365d", "2026-05-01"])
      expect(taskFiltersSchema.safeParse({ dueTo }).success).toBe(true);
  });
});
