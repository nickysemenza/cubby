import { z } from "zod";
import { id, ingredientShortcode, recipeShortcode } from "./identifier-fields";
import { amount, positiveAmount } from "./codec";
import { timestampedFields } from "./base-entity";
import { recipeTopLevel } from "./recipe-shared";

const ingredientProvenance = {
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
};

/**
 * The key of a section line's read payload that nests the record its input id names:
 * `ingredient: {id, name…}` for `ingredientId`, `recipe: {id…}` for `recipeId` (the id is that
 * record's `id`). Declared once as `readFrom` metadata on the input fields, which `pnpm generate`
 * carries into the manifest as `readPath` for native's generic read-to-input projection, and
 * applied here for web (`recipeLineAsInput`); `golden-vectors/structured-roundtrip.json` pins
 * both against a real server read.
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

const sectionLineFields = {
  id: z.uuid(),
  amounts: z.array(amount),
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
  ...timestampedFields,
};
const sectionIngredientRef = z.object({
  id: ingredientShortcode,
  name: z.string(),
  ...timestampedFields,
  aliases: z.array(z.string()).optional(),
});
const ingredientLine = z.object({
  ...sectionLineFields,
  type: z.literal("ingredient"),
  recipe: z.null(),
  ingredient: sectionIngredientRef,
});
const recipeLine = z.object({
  ...sectionLineFields,
  type: z.literal("recipe"),
  recipe: z.lazy(() => recipeTopLevel),
  ingredient: z.null(),
});
export const recipeSectionIngredientOut = z.discriminatedUnion("type", [
  ingredientLine,
  recipeLine,
]);
export const recipeSectionOut = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  instructions: z.array(z.object({ instruction: z.string() })),
  ...timestampedFields,
  ingredients: z.array(recipeSectionIngredientOut),
});
export const recipeSectionsOut = z.array(recipeSectionOut);

/**
 * A section line as the update input that leaves it unchanged: the read payload's nested target
 * flattened to `ingredientId`/`recipeId` (`LINE_TARGET`), everything the input does not name
 * (timestamps, the nested records) stripped by the schema.
 */
export const recipeLineAsInput = (
  line: z.infer<typeof recipeSectionIngredientOut>,
): z.infer<typeof recipeIngredientInput> =>
  recipeIngredientInput.parse({
    ...line,
    ingredientId: line[LINE_TARGET.ingredientId]?.id ?? null,
    recipeId: line[LINE_TARGET.recipeId]?.id ?? null,
  });
