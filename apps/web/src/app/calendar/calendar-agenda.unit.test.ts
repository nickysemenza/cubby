import type { CalendarItem } from "@cubby/schemas/calendar";
import {
  unsafeMealShortcode,
  unsafeTaskShortcode,
} from "@cubby/schemas/identifiers";
import { addDays, format, parseISO } from "date-fns";
import { describe, expect, it } from "vitest";
import { groupItemsByDay } from "./calendar-agenda";

/** All-day events are half-open: a single day ends on the NEXT day, the same
 * shape `repo/calendar.ts` emits via `shiftPlainDate(date, 1)`. */
const nextDay = (day: string) =>
  format(addDays(parseISO(day), 1), "yyyy-MM-dd");

const meal = (id: string, startDate: string): CalendarItem => ({
  kind: "meal",
  id: unsafeMealShortcode(id),
  title: id,
  startDate,
  endDateExclusive: nextDay(startDate),
  interaction: "move",
  sortOrder: null,
  mealType: null,
  mealKind: "cooked",
  recipeNames: [],
  cost: 0,
  calories: 0,
  nutritionPending: false,
});

const task = (
  id: string,
  startDate: string,
  endDateExclusive: string,
): CalendarItem => ({
  kind: "task",
  id: unsafeTaskShortcode(id),
  title: id,
  startDate,
  endDateExclusive,
  interaction: "move",
  status: "not_started",
  trade: "planning",
  projectName: null,
});

/** The month grid's own rule, passed in so the agenda can't disagree with it. */
const includesDay = (item: CalendarItem, day: string) =>
  day >= item.startDate && day < item.endDateExclusive;

describe("groupItemsByDay", () => {
  it("groups by day in date order", () => {
    const groups = groupItemsByDay(
      [meal("MEL-2222", "2026-03-03"), meal("MEL-1111", "2026-03-01")],
      includesDay,
    );
    expect(groups.map((g) => g.day)).toEqual(["2026-03-01", "2026-03-03"]);
  });

  it("omits days with nothing on them", () => {
    // The gap between the 1st and the 5th produces no rows at all — an agenda
    // that listed every empty day would be mostly empty days.
    const groups = groupItemsByDay(
      [meal("MEL-1111", "2026-03-01"), meal("MEL-3333", "2026-03-05")],
      includesDay,
    );
    expect(groups).toHaveLength(2);
  });

  it("repeats a multi-day span under each day it covers", () => {
    // Same rule the month grid paints by: a task spanning the 1st-3rd is on
    // the 2nd even though it starts on the 1st.
    const groups = groupItemsByDay(
      [
        task("TSK-1111", "2026-03-01", "2026-03-04"),
        meal("MEL-2222", "2026-03-02"),
      ],
      includesDay,
    );
    const secondDay = groups.find((g) => g.day === "2026-03-02");
    expect(secondDay?.items.map((i) => i.id)).toEqual(["TSK-1111", "MEL-2222"]);
  });
});
