import { describe, expect, it } from "vitest";
import {
  calendarSearchDefaults,
  calendarSearchSchema,
} from "./calendar-search";

describe("calendar search params", () => {
  it("accepts linkable calendar filters and selected dates", () => {
    expect(
      calendarSearchSchema.parse({
        date: "2026-07-01",
        day: "2026-07-14",
        kinds: "meal,task",
        projectKinds: "renovation,garden",
      }),
    ).toEqual({
      date: "2026-07-01",
      day: "2026-07-14",
      kinds: "meal,task",
      projectKinds: "renovation,garden",
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
});
