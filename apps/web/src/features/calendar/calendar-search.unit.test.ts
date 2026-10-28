import {
  calendarSourceMatches,
  calendarFiltersInput,
} from "@cubby/schemas/calendar";
import { describe, expect, it } from "vitest";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";

import { buildCalendarFilters } from "./calendar-filters";
import {
  calendarSearchDefaults,
  calendarSearchSchema,
} from "./calendar-search";

const queryClient = await metadataQueryClient();

describe("calendar search params", () => {
  it("preserves source exclusions and exact scope through the route codec", () => {
    const filters = buildCalendarFilters(
      queryClient,
      calendarSearchSchema.parse({
        "task.projectIdExclude": "PRJ-2345",
        "task.includeSubProjects": "false",
      }),
    );
    expect(filters.filters?.task).toMatchObject({
      projectIdExclude: ["PRJ-2345"],
      includeSubProjects: false,
    });
    expect(calendarSourceMatches("task", filters)).toBe(true);
    expect(calendarSourceMatches("meal", filters)).toBe(false);
    expect(
      calendarSourceMatches(
        "meal",
        calendarFiltersInput.parse({
          filters: { task: { includeSubProjects: false } },
        }),
      ),
    ).toBe(true);
  });

  it("accepts linkable calendar filters and selected dates", () => {
    expect(
      calendarSearchSchema.parse({
        period: "week",
        date: "2026-07-01",
        day: "2026-07-14",
        kinds: "meal,task",
        "project.kinds": "renovation,garden",
      }),
    ).toMatchObject({
      period: "week",
      date: "2026-07-01",
      day: "2026-07-14",
      kinds: "meal,task",
      "project.kinds": "renovation,garden",
    });
  });

  it("keeps a param the router JSON-parsed into a non-string", () => {
    // `?future=true` arrives as the BOOLEAN true. A bare z.string() would drop
    // it into `.catch(undefined)`, leaving an unfiltered calendar that reads as
    // a real answer — the exact hole `urlStringParam` exists to close.
    expect(
      calendarSearchSchema.parse({ "spending.future": true }),
    ).toMatchObject({
      "spending.future": "true",
    });
  });

  it("drops malformed dates without breaking the route", () => {
    expect(
      calendarSearchSchema.parse({
        date: "July 2026",
        day: "2026-7-4",
      }),
    ).toEqual(calendarSearchDefaults);
  });

  it("falls back to the default month for an unknown period", () => {
    expect(calendarSearchSchema.parse({ period: "agenda" })).toEqual(
      calendarSearchDefaults,
    );
  });
});
