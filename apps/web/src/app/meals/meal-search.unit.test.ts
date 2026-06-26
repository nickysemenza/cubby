import { describe, expect, it } from "vitest";
import {
  formatWeekSearch,
  getDefaultShoppingRange,
  mealCalendarSearchSchema,
  mealSuggestionsSearchSchema,
  parseWeekStart,
  shoppingListSearchSchema,
} from "./meal-search";

describe("meal route search", () => {
  it("accepts typed calendar view/week params", () => {
    expect(
      mealCalendarSearchSchema.parse({
        view: "table",
        week: "2026-06-24",
      }),
    ).toEqual({ view: "table", week: "2026-06-24" });
  });

  it("soft-falls back for malformed calendar params", () => {
    expect(
      mealCalendarSearchSchema.parse({
        view: "board",
        week: "next-week",
      }),
    ).toEqual({ view: undefined, week: undefined });
  });

  it("normalizes arbitrary dates to the visible week start", () => {
    expect(formatWeekSearch(parseWeekStart("2026-06-24"))).toBe("2026-06-21");
  });

  it("uses the current week when the week param is absent or invalid", () => {
    const referenceDate = new Date(2026, 5, 26);

    expect(formatWeekSearch(parseWeekStart(undefined, referenceDate))).toBe(
      "2026-06-21",
    );
    expect(formatWeekSearch(parseWeekStart("nope", referenceDate))).toBe(
      "2026-06-21",
    );
  });

  it("accepts typed shopping range params", () => {
    expect(
      shoppingListSearchSchema.parse({
        from: "2026-06-21",
        to: "2026-06-27",
      }),
    ).toEqual({ from: "2026-06-21", to: "2026-06-27" });
  });

  it("soft-falls back for malformed shopping range params", () => {
    expect(
      shoppingListSearchSchema.parse({
        from: "yesterday",
        to: "tomorrow",
      }),
    ).toEqual({ from: undefined, to: undefined });
  });

  it("derives the default shopping range from the current week", () => {
    expect(getDefaultShoppingRange(new Date(2026, 5, 26))).toEqual({
      from: "2026-06-21",
      to: "2026-06-27",
    });
  });

  it("accepts suggestion filters and treats all as the clean default", () => {
    expect(mealSuggestionsSearchSchema.parse({ filter: "ready" })).toEqual({
      filter: "ready",
    });
    expect(mealSuggestionsSearchSchema.parse({ filter: "all" })).toEqual({
      filter: undefined,
    });
  });
});
