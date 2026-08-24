import { mealCreateInput } from "@cubby/schemas/meal";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import {
  createMeal,
  getMealsByDateRange,
  getUpcomingMealSummary,
  mealList,
} from "./meal";
import { createRecipeFixture, makeRecipeInput } from "./repo.fixtures";

const pagination = { pageIndex: 0, pageSize: 50 };

describe("getUpcomingMealSummary", () => {
  const ctx = withTestDb();

  it("matches the canonical date-range results while returning at most four rows", async () => {
    for (let day = 1; day <= 6; day += 1) {
      await createMeal(
        ctx.db,
        mealCreateInput.parse({
          date: `2026-06-0${day}`,
          name: `summary meal ${day}`,
        }),
        ctx.actor,
      );
    }

    const canonical = await getMealsByDateRange(
      ctx.db,
      "2026-06-01",
      "2026-06-30",
    );
    const compact = await getUpcomingMealSummary(
      ctx.db,
      "2026-06-01",
      "2026-06-30",
    );

    expect(compact).toHaveLength(4);
    expect(compact).toEqual(
      canonical.slice(0, 4).map((meal) => ({
        id: meal.id,
        date: meal.date,
        name: meal.name,
        mealType: meal.mealType,
        mealKind: meal.mealKind,
        totals: meal.totals,
      })),
    );
  });
});

/**
 * `mealFilterFields` spreads `mealRelatedFilterFields` (the recipe trio) and the
 * manifest renders its control, but `mealList` never called
 * `relatedWhereConditions` — so the Meals table sent a recipe filter the server
 * silently ignored and returned every meal. Same drift as #588's wish gap; found
 * by the generic guard in `filter-application.integration.test.ts`, which pins the
 * narrowing direction. These pin the other direction: that the predicate matches
 * the RIGHT meals, not merely fewer of them.
 */
describe("mealList related-recipe filters", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const planned = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Braised Short Ribs" }),
      ctx.actor,
    );
    const other = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Sheet Pan Salmon" }),
      ctx.actor,
    );
    const withPlanned = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-02-01",
        name: "Sunday dinner",
        recipes: [{ recipeId: planned.id, scale: 1 }],
      }),
      ctx.actor,
    );
    const withOther = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-02-02",
        name: "Monday dinner",
        recipes: [{ recipeId: other.id, scale: 1 }],
      }),
      ctx.actor,
    );
    return { planned, other, withPlanned, withOther };
  };

  it("narrows to the meals planning that recipe", async () => {
    const { planned, withPlanned } = await seed();
    const { data } = await mealList(
      ctx.db,
      { recipeId: planned.id },
      [],
      pagination,
    );
    expect(data.map((row) => row.id)).toEqual([withPlanned.id]);
  });

  it("narrows on the related recipe search the manifest exposes", async () => {
    const { withOther } = await seed();
    const { data } = await mealList(
      ctx.db,
      { recipeSearch: "Salmon" },
      [],
      pagination,
    );
    expect(data.map((row) => row.id)).toEqual([withOther.id]);
  });

  it("splits meals by whether any recipe is planned at all", async () => {
    const { withPlanned, withOther } = await seed();
    await createMeal(
      ctx.db,
      mealCreateInput.parse({ date: "2026-02-03", name: "Nothing planned" }),
      ctx.actor,
    );

    const has = await mealList(
      ctx.db,
      { recipePresenceFilter: "has" },
      [],
      pagination,
    );
    expect(has.data.map((row) => row.id).sort()).toEqual(
      [withPlanned.id, withOther.id].sort(),
    );

    const none = await mealList(
      ctx.db,
      { recipePresenceFilter: "none" },
      [],
      pagination,
    );
    expect(none.data.map((row) => row.name)).toEqual(["Nothing planned"]);
  });
});

describe("mealList classification filters", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const dinnerOut = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-03-01",
        name: "Anniversary",
        mealType: "dinner",
        mealKind: "eating_out",
      }),
      ctx.actor,
    );
    const dinnerCooked = await createMeal(
      ctx.db,
      mealCreateInput.parse({
        date: "2026-03-02",
        name: "Roast",
        mealType: "dinner",
      }),
      ctx.actor,
    );
    const unslotted = await createMeal(
      ctx.db,
      mealCreateInput.parse({ date: "2026-03-03", name: "Whenever" }),
      ctx.actor,
    );
    return { dinnerOut, dinnerCooked, unslotted };
  };

  it("defaults mealKind to cooked and leaves mealType null", async () => {
    const { unslotted } = await seed();
    expect(unslotted.mealKind).toBe("cooked");
    expect(unslotted.mealType).toBeNull();
  });

  it("narrows on mealType and on mealKind", async () => {
    const { dinnerOut, dinnerCooked } = await seed();

    const dinners = await mealList(
      ctx.db,
      { mealType: "dinner" },
      [],
      pagination,
    );
    expect(dinners.data.map((row) => row.id).sort()).toEqual(
      [dinnerOut.id, dinnerCooked.id].sort(),
    );

    const out = await mealList(
      ctx.db,
      { mealKind: "eating_out" },
      [],
      pagination,
    );
    expect(out.data.map((row) => row.id)).toEqual([dinnerOut.id]);
  });

  it("ORs the mealType presence sentinel with the value list", async () => {
    const { dinnerOut, dinnerCooked, unslotted } = await seed();

    const none = await mealList(
      ctx.db,
      { mealTypePresenceFilter: "none" },
      [],
      pagination,
    );
    expect(none.data.map((row) => row.id)).toEqual([unslotted.id]);

    const both = await mealList(
      ctx.db,
      { mealType: "dinner", mealTypePresenceFilter: "none" },
      [],
      pagination,
    );
    expect(both.data.map((row) => row.id).sort()).toEqual(
      [dinnerOut.id, dinnerCooked.id, unslotted.id].sort(),
    );
  });
});

describe("mealList sorting", () => {
  const ctx = withTestDb();

  const makeMeal = (date: string, overrides: Record<string, unknown> = {}) =>
    createMeal(
      ctx.db,
      mealCreateInput.parse({ date, ...overrides }),
      ctx.actor,
    );

  it("sorts mealType by slot, not alphabetically", async () => {
    // The regression this pins: "dessert" < "dinner" as text, so a plain
    // column sort would put dessert first. Slot order is what the calendar
    // uses and what a reader expects.
    await makeMeal("2026-05-01", { name: "D", mealType: "dessert" });
    await makeMeal("2026-05-02", { name: "B", mealType: "breakfast" });
    await makeMeal("2026-05-03", { name: "N", mealType: "dinner" });

    const { data } = await mealList(
      ctx.db,
      {},
      [{ orderBy: "mealType", direction: "asc" }],
      pagination,
    );

    expect(data.map((row) => row.mealType)).toEqual([
      "breakfast",
      "dinner",
      "dessert",
    ]);
  });

  it("sorts unslotted meals last in both directions", async () => {
    await makeMeal("2026-05-04", { name: "Slotted", mealType: "lunch" });
    await makeMeal("2026-05-05", { name: "Unslotted" });

    for (const direction of ["asc", "desc"] as const) {
      const { data } = await mealList(
        ctx.db,
        {},
        [{ orderBy: "mealType", direction }],
        pagination,
      );
      expect(data.at(-1)?.name).toBe("Unslotted");
    }
  });

  it("orders unnamed meals by date within the name-sort NULL block", async () => {
    await makeMeal("2026-05-06");
    await makeMeal("2026-05-08");
    await makeMeal("2026-05-07");
    await makeMeal("2026-05-09", { name: "Named" });

    const { data } = await mealList(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      pagination,
    );

    expect(data[0]?.name).toBe("Named");
    expect(data.slice(1).map((row) => row.date)).toEqual([
      "2026-05-08",
      "2026-05-07",
      "2026-05-06",
    ]);
  });
});
