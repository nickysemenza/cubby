import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";

import type { ListRowOf } from "~/entity/display/list-renderer-types";
import {
  entityReadFixture,
  fieldValueFixture,
} from "~/entity/fields/field-envelope.fixtures";
const mealOut = entityFieldEnvelopeSchemas.meal.list;
import { type MealCreateInput } from "@cubby/schemas/entities/meal";
import { mealAddRecipeInput } from "@cubby/schemas/meal";
import { buildNutrition, withMacros } from "@cubby/schemas/nutrition";
import { testCompleteDataQuality, testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { ai } from "~/integrations/tanstack-query/generated/catalog/ai.gen";
import { entityMutation } from "~/integrations/tanstack-query/generated/catalog/entityMutation.gen";
import { meal } from "~/integrations/tanstack-query/generated/catalog/meal.gen";
import { entityBrowserMutationCommandSchema } from "~/server/entity-kernel/contracts";

import { type AddToMealOperations, AddToMeal } from "./add-to-meal";

const recipeId = testShortcode("recipe", "RCP-4K7M");
const createdMeals: MealCreateInput[] = [];
const addedRecipes: Array<z.output<typeof mealAddRecipeInput>> = [];
let mealRequests = 0;
const emptyTotals = withMacros({
  cost: { status: "unavailable" as const, reason: "empty" as const },
  nutrition: buildNutrition(() => ({
    status: "unavailable",
    reason: "empty",
  })),
});

const tuesdayDinner = entityReadFixture(mealOut, {
  fields: {
    mealType: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["mealType"],
      "dinner",
    ),
    mealKind: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["mealKind"],
      "cooked",
    ),
    images: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["images"],
      [],
    ),
    recipeNames: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["recipeNames"],
      [],
    ),
    dataQuality: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["dataQuality"],
      testCompleteDataQuality(),
    ),
  },
  id: testShortcode("meal", "MEL-4K7M"),
  name: "Tuesday dinner",
  date: "2026-06-16",
  sortOrder: null,

  recipes: [],

  totals: emptyTotals,
  displayName: "Tuesday dinner",

  createdAt: new Date("2026-06-16T12:00:00Z"),
  updatedAt: new Date("2026-06-16T12:00:00Z"),
});

const cornerDeli = entityReadFixture(mealOut, {
  fields: {
    mealType: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["mealType"],
      "lunch",
    ),
    mealKind: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["mealKind"],
      "eating_out",
    ),
    images: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["images"],
      [],
    ),
    recipeNames: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["recipeNames"],
      [],
    ),
    dataQuality: fieldValueFixture(
      entityFieldEnvelopeSchemas.meal.detail.shape.fields.shape["dataQuality"],
      testCompleteDataQuality(),
    ),
  },
  id: testShortcode("meal", "MEL-9Q2X"),
  name: "Corner Deli",
  date: "2026-06-16",
  sortOrder: null,

  recipes: [],

  totals: emptyTotals,
  displayName: "Corner Deli",

  createdAt: new Date("2026-06-16T12:00:00Z"),
  updatedAt: new Date("2026-06-16T12:00:00Z"),
});

const meals: MealOut[] = [tuesdayDinner, cornerDeli];

/** Real operation descriptors with only their unreachable transport replaced. */
const testOperations: AddToMealOperations = {
  suggestFields: ai.suggestFields.withTransport(async () => ({
    suggestions: {},
    outcomes: {},
  })),
  existingMeals: meal.getByDateRange.withTransport(async () => {
    mealRequests += 1;
    return meals;
  }),
  addRecipe: meal.addRecipe.withTransport(async ({ input }) => {
    const command = meal.addRecipe.definition.input.parse(input);
    addedRecipes.push(command);
    return tuesdayDinner;
  }),
  mealMutation: entityMutation.mutate.withTransport(async ({ input }) => {
    const command = entityBrowserMutationCommandSchema.parse(input);
    if (command.action === "create" && command.entity === "meal") {
      createdMeals.push(command.data);
      return {
        action: "create" as const,
        entity: "meal" as const,
        item: {
          id: tuesdayDinner.id,
          date: tuesdayDinner.date,
          fields: { mealType: tuesdayDinner.fields.mealType },
        },
        appliedFields: [],
        sideEffects: {},
      };
    }
    throw new Error("Add to meal only issues a meal create command.");
  }),
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  createdMeals.length = 0;
  addedRecipes.length = 0;
  mealRequests = 0;
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function renderAddToMeal() {
  return render(
    <AddToMeal
      recipeId={recipeId}
      recipeName="Roasted vegetables"
      operations={testOperations}
    />,
    {
      wrapper: harness.wrapper,
    },
  );
}

/** A choose-mode pick: open from the keyboard, hover, then click. */
async function chooseMeal(picker: HTMLElement, name: string) {
  picker.focus();
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name });
  fireEvent.mouseMove(option);
  fireEvent.click(option);
}

async function openMealPicker() {
  fireEvent.click(await screen.findByRole("button", { name: "Add to meal" }));
  const picker = await screen.findByRole("combobox", { name: "meal" });
  await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
  return picker;
}

describe("AddToMeal", () => {
  it("offers existing meal slots and adds the recipe to the selected slot", async () => {
    renderAddToMeal();
    const picker = await openMealPicker();

    expect(mealRequests).toBe(1);
    await chooseMeal(picker, "Tuesday dinner (0 recipes)");
    fireEvent.click(
      screen.getByRole("button", { name: "Add to selected meal" }),
    );

    await waitFor(() =>
      expect(addedRecipes).toEqual([
        {
          mealId: tuesdayDinner.id,
          recipeId,
          scale: 1,
          convertToCooked: false,
        },
      ]),
    );
    expect(createdMeals).toEqual([]);
    await waitFor(() => expect(mealRequests).toBeGreaterThan(1));
  });

  it("retains creating a separate meal as the default", async () => {
    renderAddToMeal();
    await openMealPicker();
    fireEvent.click(screen.getByRole("button", { name: "Create meal" }));

    await waitFor(() => expect(createdMeals).toHaveLength(1));
    expect(createdMeals[0]).toMatchObject({
      mealKind: "cooked",
      recipes: [{ recipeId, scale: 1 }],
    });
    expect(createdMeals[0]?.date).toEqual(expect.any(String));
    expect(createdMeals[0]?.mealType).toEqual(expect.any(String));
    expect(addedRecipes).toEqual([]);
  });

  it("submits the reviewed conversion with recipe addition in one command", async () => {
    renderAddToMeal();
    const picker = await openMealPicker();

    await chooseMeal(picker, "Corner Deli — Eating out");
    expect(
      screen.getByText(/aren't added to the shopping list/i),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Add to selected meal" }),
    );

    await waitFor(() => expect(addedRecipes).toHaveLength(1));
    expect(addedRecipes).toEqual([
      { mealId: cornerDeli.id, recipeId, scale: 1, convertToCooked: true },
    ]);
  });
});

type MealOut = ListRowOf<"meal">;
