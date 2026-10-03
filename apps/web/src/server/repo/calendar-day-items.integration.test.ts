import { calendarRangeInput } from "@cubby/schemas/calendar";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getCalendarRange } from "./calendar";
import { createMealWithEntityId } from "./meal/crud";
import { insertWithShortcode } from "./shortcode-utils";

describe("calendar day membership", () => {
  const ctx = withTestDb();

  // Native and web both bucket items by day; the server owns the rule so a
  // multi-day span belongs to every day it covers and nothing outside it.
  it("lists each item on every in-range day it covers, and only those days", async () => {
    const { output: meal } = await createMealWithEntityId(
      ctx.db,
      { date: "2026-09-21", name: "Synthetic supper", mealType: "dinner" },
      ctx.actor,
    );
    const task = await insertWithShortcode(ctx.db, "task", {
      name: "Synthetic multi-day task",
      trade: "planning",
      dueDate: "2026-09-20",
      dueEndDate: "2026-09-22",
    });

    const range = await getCalendarRange(
      ctx.db,
      calendarRangeInput.parse({
        startDate: "2026-09-19",
        endDateExclusive: "2026-09-24",
        kinds: ["meal", "task"],
      }),
    );

    expect(Object.keys(range.days)).toHaveLength(5);
    expect(range.days["2026-09-19"]?.itemIds).toEqual([]);
    expect(range.days["2026-09-20"]?.itemIds).toEqual([task.shortcode]);
    expect([...(range.days["2026-09-21"]?.itemIds ?? [])].sort()).toEqual(
      [meal.id, task.shortcode].sort(),
    );
    expect(range.days["2026-09-22"]?.itemIds).toEqual([task.shortcode]);
    // The end date is inclusive for a task, so the day after is empty.
    expect(range.days["2026-09-23"]?.itemIds).toEqual([]);
    expect(range.days["2026-09-21"]?.mealCount).toBe(1);
  });
});
