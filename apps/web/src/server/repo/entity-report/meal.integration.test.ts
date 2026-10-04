import { entityReportOut } from "@cubby/schemas/entity-report";
import { buildEntity } from "tooling/factories/build";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createLedgerParty } from "~/server/repo/ledger-party";
import {
  addRecipeToMeal,
  createMealWithEntityId,
} from "~/server/repo/meal/crud";
import { saveMealRecipePreparation } from "~/server/repo/meal/portions";
import {
  createRecipeFixture,
  makeRecipeInput,
} from "~/server/repo/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

import { buildEntityReport } from "./index";

/**
 * Editing a meal's composition on every client: the recipes with their scale, and each prepared
 * recipe's portions. The server words every row and composes every command's exact request
 * (which operation, which ids); the person supplies only the scale, recipe, eater and amount a
 * command's inputs ask for, so neither client reassembles a meal write from a label.
 */
describe("meal.composition", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const recipe = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({ name: "Synthetic stew" }),
      ctx.actor,
    );
    const meal = await createMealWithEntityId(
      ctx.db,
      buildEntity("meal", { date: "2026-09-21", name: "Cook night" }),
      ctx.actor,
    );
    const added = await addRecipeToMeal(
      ctx.db,
      meal.entityId,
      { recipeId: recipe.id, scale: 2, sortOrder: 0 },
      ctx.actor,
    );
    const eater = await createLedgerParty(
      ctx.db,
      { name: "Test eater", kind: "member", notes: null },
      ctx.actor,
    );
    if (!eater.output) throw new Error("fixture setup failed");
    await saveMealRecipePreparation(
      ctx.db,
      {
        mealRecipeId: added.mealRecipeId,
        changes: [
          {
            action: "set",
            mealId: meal.output.id,
            ledgerPartyId: eater.output.id,
            amount: { value: 1, unit: "serving" },
            confirmed: false,
          },
        ],
      },
      ctx.actor,
    );
    return { meal, mealRecipeId: added.mealRecipeId, eater: eater.output };
  };

  const blocks = async (mealCode: string) =>
    entityReportOut.parse(
      await buildEntityReport(
        ctx.db,
        { slot: "meal.composition", id: mealCode },
        async () => null,
        ctx.actor,
        createTestRequestContext(ctx.db).services,
      ),
    ).blocks;

  it("offers scale, remove and add as commands carrying the server's request", async () => {
    const { meal, mealRecipeId } = await seed();
    const out = await blocks(meal.output.id);
    const recipes = out.find(
      (block) => block.kind === "records" && block.title === "Recipes",
    );
    if (recipes?.kind !== "records") throw new Error("no recipes block");

    expect(recipes.rows).toHaveLength(1);
    expect(recipes.rows[0]).toMatchObject({
      entity: "recipe",
      title: "Synthetic stew",
      key: mealRecipeId,
    });
    expect(recipes.rows[0]?.subtitle).toMatch(/×2/);
    expect(recipes.rows[0]?.commands).toMatchObject([
      {
        label: "Change scale",
        confirm: null,
        inputs: [{ kind: "number", key: "scale", initial: 2, min: 0.01 }],
        request: { kind: "meal-scale-recipe", mealRecipeId, scale: null },
      },
      {
        label: "Remove",
        confirm: "Remove Synthetic stew from this meal?",
        request: { kind: "meal-remove-recipe", mealRecipeId },
      },
    ]);
    expect(recipes.commands).toMatchObject([
      {
        label: "Add recipe",
        inputs: [
          { kind: "record", key: "recipeId", entity: "recipe" },
          { kind: "number", key: "scale", initial: 1, min: 0.01 },
        ],
        // A cooked meal needs no conversion, so nothing is asked.
        request: {
          kind: "meal-add-recipe",
          mealId: meal.output.id,
          recipeId: null,
          scale: null,
          convertToCooked: false,
        },
      },
    ]);
  });

  it("lists each portion with its status and the commands that settle it", async () => {
    const { meal, mealRecipeId, eater } = await seed();
    const out = await blocks(meal.output.id);
    const portions = out.find(
      (block) =>
        block.kind === "records" && block.title === "Portions · Synthetic stew",
    );
    if (portions?.kind !== "records") throw new Error("no portions block");

    expect(portions.rows).toHaveLength(1);
    expect(portions.rows[0]).toMatchObject({
      title: "Test eater",
      statuses: [{ label: "Planned" }],
    });
    expect(portions.rows[0]?.subtitle).toMatch(/1 serving/);
    expect(portions.rows[0]?.commands).toMatchObject([
      {
        label: "Mark eaten",
        request: {
          kind: "meal-portion-set",
          mealRecipeId,
          mealId: meal.output.id,
          ledgerPartyId: eater.id,
          value: 1,
          unit: "serving",
          confirmed: true,
        },
      },
      {
        label: "Remove portion",
        request: {
          kind: "meal-portion-remove",
          mealRecipeId,
          mealId: meal.output.id,
          ledgerPartyId: eater.id,
        },
      },
    ]);
    expect(portions.commands?.map((command) => command.label)).toEqual([
      "Set actual yield",
    ]);
  });

  it("offers Add portion only to eaters without a portion, so it never replaces one silently", async () => {
    const { meal } = await seed();
    // The seeded eater already has a portion, so with nobody else there is no one to add.
    const alone = await blocks(meal.output.id);
    const aloneBlock = alone.find(
      (block) =>
        block.kind === "records" && block.title?.startsWith("Portions"),
    );
    if (aloneBlock?.kind !== "records") throw new Error("no portions block");
    expect(aloneBlock.commands?.map((command) => command.label)).toEqual([
      "Set actual yield",
    ]);

    const other = await createLedgerParty(
      ctx.db,
      { name: "Second eater", kind: "guest", notes: null },
      ctx.actor,
    );
    const out = await blocks(meal.output.id);
    const portions = out.find(
      (block) =>
        block.kind === "records" && block.title?.startsWith("Portions"),
    );
    if (portions?.kind !== "records") throw new Error("no portions block");
    const add = portions.commands?.find(
      (command) => command.label === "Add portion",
    );
    expect(add?.inputs?.map((input) => input.key)).toEqual([
      "ledgerPartyId",
      "value",
      "unit",
    ]);
    // The eater is picked from the server's list of who has no portion, not searched freely.
    expect(add?.inputs?.[0]).toMatchObject({
      kind: "choice",
      options: [{ value: other.output!.id, label: "Second eater" }],
    });
  });

  it("asks whether to switch a not-cooked meal to cooked when a recipe is added", async () => {
    const leftovers = await createMealWithEntityId(
      ctx.db,
      buildEntity("meal", {
        date: "2026-09-23",
        name: "Leftover night",
        mealKind: "leftovers",
      }),
      ctx.actor,
    );
    const out = await blocks(leftovers.output.id);
    const recipes = out.find((block) => block.kind === "records");
    if (recipes?.kind !== "records") throw new Error("expected records");
    const add = recipes.commands?.[0];
    expect(add).toMatchObject({
      label: "Add recipe",
      request: { kind: "meal-add-recipe", convertToCooked: null },
    });
    expect(add?.inputs?.map((input) => input.key)).toEqual([
      "recipeId",
      "scale",
      "convertToCooked",
    ]);
    expect(add?.inputs?.[2]).toMatchObject({
      kind: "choice",
      initial: "true",
      options: [
        { value: "true", label: "Switch this meal to cooked" },
        { value: "false", label: "Keep it as it is" },
      ],
    });
  });

  it("says a meal that needs no recipe has nothing to compose", async () => {
    const meal = await createMealWithEntityId(
      ctx.db,
      buildEntity("meal", {
        date: "2026-09-22",
        name: "Out to eat",
        mealKind: "eating_out",
      }),
      ctx.actor,
    );
    const out = await blocks(meal.output.id);
    const recipes = out.find((block) => block.kind === "records");
    expect(recipes).toMatchObject({
      rows: [],
      empty: expect.stringContaining("no recipe required"),
    });
  });
});
