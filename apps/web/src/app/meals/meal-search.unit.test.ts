import { describe, expect, it } from "vitest";
import {
  formatWeekSearch,
  getDefaultShoppingRange,
  mealCalendarSearchSchema,
  mealSuggestionsSearchSchema,
  parseWeekStart,
  shoppingListSearchDefaults,
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

  /**
   * This route's `validateSearch` is a strict `z.object`, so any key it doesn't
   * declare is stripped on every navigate. Before `tableSearchFields` was
   * merged in, that silently ate the Table view's urlSync: `useTableState`
   * wrote sort/page/pageSize, the route dropped them, and since
   * `lastWrittenUrlState` was already set it never retried — no error, no
   * loop, the sort just never stuck.
   */
  it("preserves the table-state keys useTableState writes", () => {
    expect(
      mealCalendarSearchSchema.parse({
        view: "table",
        week: "2026-06-24",
        sort: "-date",
        page: 2,
        pageSize: 50,
      }),
    ).toMatchObject({ sort: "-date", page: 2, pageSize: 50 });
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

  it("accepts the shopping list's renderer param", () => {
    expect(
      shoppingListSearchSchema.parse({
        view: "matrix",
        from: "2026-06-21",
        to: "2026-06-27",
      }),
    ).toEqual({ view: "matrix", from: "2026-06-21", to: "2026-06-27" });
  });

  it("soft-falls back for an unknown renderer", () => {
    expect(shoppingListSearchSchema.parse({ view: "grid" })).toMatchObject({
      view: undefined,
    });
  });

  /**
   * `stripSearchParams` drops any key whose value equals its default, so a key
   * missing from the defaults object is never stripped and leaks into every
   * URL. Cheap to get wrong when adding a param, invisible when you do.
   */
  it("declares a default for every search key", () => {
    expect(Object.keys(shoppingListSearchDefaults).sort()).toEqual(
      Object.keys(shoppingListSearchSchema.shape).sort(),
    );
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
