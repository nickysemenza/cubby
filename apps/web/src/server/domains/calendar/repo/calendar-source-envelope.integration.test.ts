import { calendarRangeInput } from "@cubby/schemas/calendar";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMealWithEntityId } from "~/server/domains/meal/repo/crud";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { captureBackgroundQueue } from "~/server/testing/background-queue";

import { getCalendarRange } from "./calendar";

let queue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  queue = captureBackgroundQueue();
});
afterEach(() => queue.restore());

describe("Calendar selected source envelopes", () => {
  const ctx = withTestDb();
  const input = calendarRangeInput.parse({
    startDate: "2026-10-10",
    endDateExclusive: "2026-10-11",
  });

  it("retains event geometry while exposing current assignments and inherited source provenance", async () => {
    const project = await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic calendar workshop",
      kind: "workshop",
      defaultTrade: "building",
    });
    const task = await insertWithShortcode(ctx.db, "task", {
      name: "Synthetic calendar task",
      projectId: project.id,
      projectMode: "explicit",
      dueDate: "2026-10-10",
      trade: null,
    });
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: "Synthetic calendar materials",
      date: "2026-10-10",
      cost: 17,
      projectId: project.id,
      lineKind: "principal",
      costType: "materials",
      trade: null,
    });
    const meal = await createMealWithEntityId(
      ctx.db,
      {
        name: "Synthetic calendar supper",
        date: "2026-10-10",
        mealType: "dinner",
        mealKind: "cooked",
      },
      ctx.actor,
    );
    const result = await getCalendarRange(ctx.db, input);
    const mealItem = result.items.find(
      (item) => item.kind === "meal" && item.id === meal.output.id,
    );
    if (!mealItem || mealItem.kind !== "meal")
      throw new Error("Synthetic Meal occurrence missing");
    expect(mealItem.source.id).toBe(mealItem.id);
    expect(mealItem.source.fields.mealType.current.assignment).toMatchObject({
      kind: "value",
      value: "dinner",
    });
    expect(mealItem.source.fields.mealType.current.controls.kind).toBe(
      "editable",
    );
    expect(fieldValueOf(mealItem.source.fields.mealKind)).toBe("cooked");
    expect(fieldValueOf(mealItem.source.fields.recipeNames)).toEqual([]);
    expect(mealItem.source.fields.dataQuality).toHaveProperty("result");
    for (const key of ["mealType", "mealKind", "recipeNames", "dataQuality"])
      expect(mealItem).not.toHaveProperty(key);
    expect(mealItem.startDate).toBe("2026-10-10");
    expect(mealItem.endDateExclusive).toBe("2026-10-11");

    for (const [kind, id] of [
      ["task", task.shortcode],
      ["expense", expense.shortcode],
    ]) {
      const item = result.items.find(
        (item) => item.kind === kind && item.id === id,
      );
      if (!item || (item.kind !== "task" && item.kind !== "expense"))
        throw new Error("Synthetic trade occurrence missing");
      expect(fieldValueOf(item.source.fields.trade)).toBe("building");
      expect(item.source.fields.trade.current.assignment).toEqual({
        kind: "inherit",
      });
      expect(item.source.fields.trade.result).toMatchObject({
        kind: "live",
        decision: { provenance: { kind: "inherited" } },
      });
      expect(item).not.toHaveProperty("trade");
    }
    const projectItem = result.items.find(
      (item) => item.kind === "project" && item.id === project.shortcode,
    );
    if (!projectItem || projectItem.kind !== "project")
      throw new Error("Synthetic Project occurrence missing");
    expect(fieldValueOf(projectItem.source.fields.kind)).toBe("workshop");
    expect(projectItem).not.toHaveProperty("projectKind");
    expect(projectItem.startDate).toBe("2026-10-10");
    expect(result.days["2026-10-10"]?.mealCount).toBe(1);
  });

  it("keeps source read query count bounded as the selected Meal count grows", async () => {
    const create = (index: number) =>
      createMealWithEntityId(
        ctx.db,
        {
          name: `Synthetic batched calendar meal ${index}`,
          date: "2026-10-10",
          mealType: "dinner",
          mealKind: "cooked",
        },
        ctx.actor,
      );
    await create(0);
    const onlyMeals = calendarRangeInput.parse({ ...input, kinds: ["meal"] });
    const one = await countTestDbQueries(() =>
      getCalendarRange(ctx.db, onlyMeals),
    );
    for (let index = 1; index < 10; index += 1) await create(index);
    const many = await countTestDbQueries(() =>
      getCalendarRange(ctx.db, onlyMeals),
    );
    expect(many.result.items).toHaveLength(10);
    expect(many.queryCount).toBe(one.queryCount);
  });
});
