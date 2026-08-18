import { describe, expect, it } from "vitest";
import {
  calendarSearchDefaults,
  calendarSearchSchema,
} from "./calendar-search";

describe("calendar search params", () => {
  it("accepts linkable calendar filters and selected dates", () => {
    expect(
      calendarSearchSchema.parse({
        period: "week",
        date: "2026-07-01",
        day: "2026-07-14",
        kinds: "meal,task",
        projectKinds: "renovation,garden",
      }),
    ).toMatchObject({
      period: "week",
      date: "2026-07-01",
      day: "2026-07-14",
      kinds: "meal,task",
      projectKinds: "renovation,garden",
    });
  });

  it("keeps a param the router JSON-parsed into a non-string", () => {
    // `?future=true` arrives as the BOOLEAN true. A bare z.string() would drop
    // it into `.catch(undefined)`, leaving an unfiltered calendar that reads as
    // a real answer — the exact hole `urlStringParam` exists to close.
    expect(calendarSearchSchema.parse({ future: true })).toMatchObject({
      future: "true",
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
