import { z } from "zod";
import { amount } from "./codec";
import { baseEntitySchema, dbTimestampsOut } from "./common";
import { id, ingredientId, recipeId } from "./identifiers";
import { createInputImages, imageOut, updateInputImages } from "./image";

// Recipe source values - single source of truth for both Zod and Drizzle
export const recipeSourceValues = ["Book", "Website", "Other"] as const;

// Recipe yield schema - what the recipe produces
export const recipeYieldSchema = z.object({
  value: z.number().positive(),
  unit: z.string().min(1),
});
export type RecipeYield = z.infer<typeof recipeYieldSchema>;

// Shared building blocks for a recipe's writable fields. Defined once here so the
// output (recipeTopLevel), API input (recipeCreateInput), and the form's formSchema
// stay in sync. Each consumer applies its own null/optional wrapper because the
// optionality legitimately differs per layer (output uses nullish, input uses
// nullable+optional, the form always sends the key as null).
export const recipeMeta = z.object({ url: z.url().nullable() }).nullable();
export const recipeServings = z.number().int().positive();
export const recipeTags = z.array(z.string());

// A recipe's provenance as a strong discriminated union — invalid pairings
// (a Book with no book, a Website with no URL) are unrepresentable. Maps to/from
// the DB's `SourceType` + `SourceData` columns via the repo-side codec
// (`~/server/repo/recipe/source`); no migration. This is what finally exposes a
// cookbook recipe's book name in the API (`meta.url` only ever held web URLs).
export const recipeSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("book"), book: z.string().min(1) }),
  z.object({ type: z.literal("website"), url: z.url() }),
  z.object({ type: z.literal("other") }),
]);
export type RecipeSource = z.infer<typeof recipeSource>;

// The section-ingredient's ingredient carries its aliases so the editor can tell
// real parser drift from a re-parse that just hit one of this ingredient's
// aliases (e.g. "large eggs" → the "large brown eggs" ingredient that aliases it).
const ingredientOut = baseEntitySchema.extend({
  aliases: z.array(z.string()).optional(),
});

export const recipeTopLevel = baseEntitySchema.extend({
  meta: recipeMeta,
  // Strong provenance, derived from the DB columns on read. Output-only for now
  // (`meta.url` still drives the write path); nullish so older rows are lenient.
  source: recipeSource.nullish(),
  yield: recipeYieldSchema.nullish(),
  servings: recipeServings.nullish(),
  tags: recipeTags.nullish(),
});

// Create a base schema with common fields
const sectioningredientOut = z
  .object({
    id: z.uuid(),
    amounts: z.array(amount),
    // Provenance from import: the original unparsed line and the parser-derived
    // modifier. Null for rows created before capture, or manual/UI edits.
    rawLine: z.string().nullish(),
    modifier: z.string().nullish(),
  })
  .extend(dbTimestampsOut.shape);

// Create a discriminated union to ensure either recipe or ingredient is set
const sectionIngredientOut = z.discriminatedUnion("type", [
  sectioningredientOut.extend({
    type: z.literal("ingredient"),
    recipe: z.null(),
    ingredient: ingredientOut,
  }),
  sectioningredientOut.extend({
    type: z.literal("recipe"),
    recipe: recipeTopLevel,
    ingredient: z.null(),
  }),
]);

export type SectionIngredient = z.infer<typeof sectionIngredientOut>;

const recipeSectionOut = z
  .object({
    id: z.uuid(),
    name: z.string().nullable(),
    ingredients: z.array(sectionIngredientOut),
    instructions: z.array(z.object({ instruction: z.string() })),
  })
  .extend(dbTimestampsOut.shape);

export type SectionIngredientOut = z.infer<typeof sectionIngredientOut>;

export const recipeOut = z
  .object({
    sections: z.array(recipeSectionOut),
    images: z.array(imageOut).default([]),
  })
  .extend(recipeTopLevel.shape);

export type RecipeOut = z.infer<typeof recipeOut>;

// A cookbook as seen on the browse index: its name (the Book recipes'
// `SourceData`) and how many non-deleted recipes came from it. Not a DB entity —
// derived by grouping recipes on read.
export const cookbookSummary = z.object({
  book: z.string(),
  recipeCount: z.number().int().nonnegative(),
});
export type CookbookSummary = z.infer<typeof cookbookSummary>;

export type SectionIngredientType = z.infer<
  typeof sectionIngredientOut
>["type"];

// Schema for recipe mutations
// Raw, unparsed source line + the parser-derived modifier (e.g. "finely
// chopped"). Optional provenance carried through from import so it can be
// persisted on RecipeSectionIngredient; absent on manual/UI edits.
const ingredientProvenance = {
  rawLine: z.string().nullish(),
  modifier: z.string().nullish(),
};

export const recipeIngredientInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ingredient"),
    ingredientId: ingredientId,
    recipeId: z.null(),
    amounts: z.array(amount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
  z.object({
    type: z.literal("recipe"),
    recipeId: recipeId,
    ingredientId: z.null(),
    amounts: z.array(amount),
    id: id.optional(),
    ...ingredientProvenance,
  }),
]);
export type RecipeIngredientInput = z.infer<typeof recipeIngredientInput>;

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

export const recipeCreateInput = z
  .object({
    name: z.string(),
    meta: recipeMeta,
    yield: recipeYieldSchema.nullable().optional(),
    servings: recipeServings.nullable().optional(),
    tags: recipeTags.nullable().optional(),
    sections: z.array(recipeSectionInput),
  })
  .extend(createInputImages.shape);

export const recipeUpdateInput = z.object({
  id: recipeId,
  data: recipeCreateInput.partial().extend(updateInputImages.shape),
});

export type RecipeCreateInput = z.infer<typeof recipeCreateInput>;
export type RecipeUpdateInput = z.infer<typeof recipeUpdateInput>;
