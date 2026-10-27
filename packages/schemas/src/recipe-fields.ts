import { z } from "zod";
import { id, ingredientShortcode, recipeShortcode } from "./identifier-fields";
import { amount, positiveAmount } from "./codec";
import { timestampedFields } from "./base-entity";
import { rawRecipeTopLevel, recipeRefOut } from "./recipe-shared";

const ingredientProvenance = {
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
};

/**
 * The key of a section line's read payload that nests the record its input id names:
 * `ingredient: {id, name…}` for `ingredientId`, `recipe: {id…}` for `recipeId` (the id is that
 * record's `id`). Declared once as `readFrom` metadata on the input fields, which `pnpm generate`
 * carries into web's structured schema as `readPath` for the generic read-to-input projection,
 * and applied here by `recipeLineAsInput`. The recipe sections integration test pins both
 * against the web-only vector in `structured-value.fixtures.json`.
 */
const LINE_TARGET = { ingredientId: "ingredient", recipeId: "recipe" } as const;
const readFrom = (input: keyof typeof LINE_TARGET) =>
  `${LINE_TARGET[input]}.id`;

export const recipeIngredientInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ingredient"),
    ingredientId: ingredientShortcode.meta({
      readFrom: readFrom("ingredientId"),
    }),
    recipeId: z.null(),
    amounts: z.array(positiveAmount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: recipeShortcode.meta({ readFrom: readFrom("recipeId") }),
    ingredientId: z.null(),
    amounts: z.array(positiveAmount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
]);

export const recipeInstructionInput = z.object({
  instruction: z.string(),
  id: id.optional(),
});

export const recipeSectionInput = z.object({
  name: z.string().min(2).nullable().optional(),
  ingredients: z.array(recipeIngredientInput).min(1).optional(),
  instructions: z.array(recipeInstructionInput).min(1).optional(),
  id: id.optional(),
});

export const recipeSectionsInput = z.array(recipeSectionInput);

export const sectionLineFields = {
  // Section and line rows have UUIDs, not public entity shortcodes.
  id: z.uuid(),
  amounts: z.array(amount),
  ...ingredientProvenance,
  ...timestampedFields,
};
const sectionIngredientRef = z.object({
  id: ingredientShortcode,
  name: z.string(),
  ...timestampedFields,
  // The editor needs aliases to distinguish parser drift from a valid alias.
  aliases: z.array(z.string()).optional(),
});
export const ingredientSectionLineOut = z.object({
  ...sectionLineFields,
  type: z.literal("ingredient"),
  recipe: z.null(),
  ingredient: sectionIngredientRef,
});
export const recipeSectionLineOut = z.object({
  ...sectionLineFields,
  type: z.literal("recipe"),
  recipe: z.lazy(() => rawRecipeTopLevel),
  ingredient: z.null(),
});
export const recipeSectionIngredientOut = z.discriminatedUnion("type", [
  ingredientSectionLineOut,
  recipeSectionLineOut,
]);
export const recipeSectionFields = {
  id: z.uuid(),
  name: z.string().nullable(),
  instructions: z.array(recipeInstructionInput.omit({ id: true })),
  ...timestampedFields,
};
export const recipeSectionOut = z.object({
  ...recipeSectionFields,
  ingredients: z.array(recipeSectionIngredientOut),
});
export const recipeSectionsOut = z.array(recipeSectionOut);

/**
 * A section line as the update input that leaves it unchanged: the read payload's nested target
 * flattened to `ingredientId`/`recipeId` (`LINE_TARGET`), everything the input does not name
 * (timestamps, the nested records) stripped by the schema.
 */
export type RecipeSectionLineRead =
  | z.output<typeof ingredientSectionLineOut>
  | (Omit<z.output<typeof recipeSectionLineOut>, "recipe"> & {
      recipe: Pick<z.output<typeof rawRecipeTopLevel>, "id" | "name" | "yield">;
    });

export const recipeLineAsInput = (
  line: RecipeSectionLineRead,
): z.infer<typeof recipeIngredientInput> =>
  recipeIngredientInput.parse({
    ...line,
    ingredientId: line[LINE_TARGET.ingredientId]?.id ?? null,
    recipeId: line[LINE_TARGET.recipeId]?.id ?? null,
  });

export const recipeUsageOut = z.object({
  id: z.uuid(),
  // A usage names its recipe; amounts and source-line evidence belong to the usage.
  recipe: recipeRefOut,
  sectionName: z.string().nullish(),
  amounts: z.array(amount),
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
});
export type RecipeUsage = z.infer<typeof recipeUsageOut>;

/** Public entity-tool projection; the usage row has no public shortcode. */
export const recipeUsageMcpEntityOut = recipeUsageOut.omit({ id: true });

import { listLabel } from "./entity-definitions/label-field";
import { displayImagesField } from "./display-images";
import { rawRecipeTopLevelFields, recipeTotals } from "./recipe-shared";

export function recipeReadSchemas<
  S extends z.ZodRawShape & {
    dataQuality: z.ZodType;
    cost: z.ZodType;
    calories: z.ZodType;
    protein: z.ZodType;
    carbs: z.ZodType;
    fat: z.ZodType;
  },
>(base: z.ZodObject<S>) {
  const output = base.extend({ sections: recipeSectionsOut });
  const field = <K extends keyof S>(key: K): S[K] => base.shape[key];
  const list = z.object({
    ...rawRecipeTopLevelFields,
    dataQuality: field("dataQuality"),
    cost: field("cost"),
    calories: field("calories"),
    protein: field("protein"),
    carbs: field("carbs"),
    fat: field("fat"),
    totals: recipeTotals.nullish(),
    // Server-composed text for the computed Cost, Calories and Time columns.
    costTotalLabel: listLabel,
    caloriesTotalLabel: listLabel,
    totalMinutesLabel: listLabel,
    // Live MealRecipe rows under a live Meal — a soft-deleted Meal's plan
    // doesn't count. Backs the list's "Meals" column.
    meals: z.number().int(),
    /** Live sections. Cheap correlated scalar — the section GRAPH is not on the
     *  list path (dropping it was the ~4.7s over-fetch fix). */
    sectionCount: z.number().int(),
    // The list only ever renders a thumbnail, so the section graph AND the full
    // image projection stay off this path (loading every image was the same
    // over-fetch the `totals` comment above dropped `.sections` for).
    displayImages: displayImagesField,
  });
  return { output, list, detail: output };
}
