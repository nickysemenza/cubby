import type {
  LocationShortcode,
  ProductShortcode,
  RecipeShortcode,
} from "@cubby/shared";
import { z } from "zod";

// Generic entity ID (use sparingly - prefer specific branded types)
export const id = z.uuid().describe("entity identifier");

// Branded ID types for type safety
// Not exported - used only for type inference
const _userId = z.string().brand("UserId");
export const recipeId = z.uuid().brand("RecipeId");
export const ingredientId = z.uuid().brand("IngredientId");
export const productId = z.uuid().brand("ProductId");
export const locationId = z.uuid().brand("LocationId");
export const inventoryId = z.uuid().brand("InventoryId");
export const cookbookId = z.uuid().brand("CookbookId");
export const mealId = z.uuid().brand("MealId");
export const mealRecipeId = z.uuid().brand("MealRecipeId");

// Shortcode schemas re-exported from shared package (single source of truth)
export {
  locationShortcode,
  productShortcode,
  recipeShortcode,
} from "@cubby/shared";
import {
  locationShortcode,
  productShortcode,
  recipeShortcode,
} from "@cubby/shared";
export type { LocationShortcode, ProductShortcode, RecipeShortcode };

// Type exports
export type UserId = z.infer<typeof _userId>;
export type RecipeId = z.infer<typeof recipeId>;
export type IngredientId = z.infer<typeof ingredientId>;
export type ProductId = z.infer<typeof productId>;
export type LocationId = z.infer<typeof locationId>;
export type InventoryId = z.infer<typeof inventoryId>;
export type CookbookId = z.infer<typeof cookbookId>;
export type MealId = z.infer<typeof mealId>;
export type MealRecipeId = z.infer<typeof mealRecipeId>;

export const normalizedLocationShortcode = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(locationShortcode);
export const normalizedProductShortcode = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(productShortcode);
export const normalizedRecipeShortcode = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .pipe(recipeShortcode);

// Helper functions for unsafe casts (use only when you're certain the value is valid).
// Useful in tests and when working with external/untyped strings you know are valid.
//
// Guard against no-op casts: a branded string (e.g. `ProductId`) carries a `unique
// symbol` key beyond `keyof string`; plain strings and string literals do not. If the
// argument is already branded, `RejectBranded<T>` resolves the parameter to `never`,
// making the call a compile error — because branding the value upstream (DB `.$type<>()`
// columns, branded route params) is the correct fix, not re-casting it. This is enforced
// by `pnpm typecheck` (tsgo) and the IDE; Biome has no custom-rule support at the pinned
// version, so the type system is the lint rule.
type RejectBranded<T> = [Exclude<keyof T, keyof string>] extends [never]
  ? T
  : never;

const unsafeId = <T>(id: string): T => id as unknown as T;

export const unsafeUserId = <T extends string>(id: T & RejectBranded<T>) =>
  unsafeId<UserId>(id);
export const unsafeRecipeId = <T extends string>(id: T & RejectBranded<T>) =>
  unsafeId<RecipeId>(id);
export const unsafeIngredientId = <T extends string>(
  id: T & RejectBranded<T>,
) => unsafeId<IngredientId>(id);
export const unsafeProductId = <T extends string>(id: T & RejectBranded<T>) =>
  unsafeId<ProductId>(id);
export const unsafeLocationId = <T extends string>(id: T & RejectBranded<T>) =>
  unsafeId<LocationId>(id);
export const unsafeInventoryId = <T extends string>(id: T & RejectBranded<T>) =>
  unsafeId<InventoryId>(id);
export const unsafeCookbookId = <T extends string>(id: T & RejectBranded<T>) =>
  unsafeId<CookbookId>(id);
export const unsafeMealId = <T extends string>(id: T & RejectBranded<T>) =>
  unsafeId<MealId>(id);
export const unsafeMealRecipeId = <T extends string>(
  id: T & RejectBranded<T>,
) => unsafeId<MealRecipeId>(id);
export const unsafeLocationShortcode = <T extends string>(
  code: T & RejectBranded<T>,
) => unsafeId<LocationShortcode>(code);
export const unsafeProductShortcode = <T extends string>(
  code: T & RejectBranded<T>,
) => unsafeId<ProductShortcode>(code);
export const unsafeRecipeShortcode = <T extends string>(
  code: T & RejectBranded<T>,
) => unsafeId<RecipeShortcode>(code);
