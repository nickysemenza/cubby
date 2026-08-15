import { mealCreateInput } from "@cubby/schemas/meal";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { createMeal, mealList } from "./meal";
import { createRecipeFixture, makeRecipeInput } from "./repo.fixtures";

const pagination = { pageIndex: 0, pageSize: 50 };

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

    // "dinner OR unslotted" — the sentinel widens the picker rather than
    // narrowing it, which is what makes it a value of the same control.
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
