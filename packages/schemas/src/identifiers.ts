import type {
  CookbookShortcode,
  ExpenseShortcode,
  FinancialAccountShortcode,
  FinancialTransactionShortcode,
  IngredientShortcode,
  InventoryShortcode,
  LocationShortcode,
  MealShortcode,
  ProductShortcode,
  ProjectShortcode,
  PurchaseShortcode,
  RecipeShortcode,
  TaskShortcode,
  VendorShortcode,
  WishShortcode,
} from "@cubby/shared";
import { z } from "zod";

// Generic entity ID (use sparingly - prefer specific branded types)
export const id = z.uuid().describe("entity identifier");

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

/** Type-guarded unsafe-cast factory: same guard shape as every hand-written `unsafe*Id`. */
function makeUnsafeId<Branded>() {
  return <T extends string>(id: T & RejectBranded<T>) => unsafeId<Branded>(id);
}

/** Brand a uuid schema + return its type-guarded unsafe-cast in one call. */
function brandedId<Name extends string>(name: Name) {
  const schema = z.uuid().brand(name);
  return [schema, makeUnsafeId<z.infer<typeof schema>>()] as const;
}

// Branded ID types for type safety.
// `_userId` isn't uuid-shaped (session ids aren't uuids) and isn't exported as a
// schema, so it stays hand-written rather than going through `brandedId`.
const _userId = z.string().brand("UserId");
export const unsafeUserId = makeUnsafeId<z.infer<typeof _userId>>();
export type UserId = z.infer<typeof _userId>;

export const [recipeId, unsafeRecipeId] = brandedId("RecipeId");
export type RecipeId = z.infer<typeof recipeId>;

export const [ingredientId, unsafeIngredientId] = brandedId("IngredientId");
export type IngredientId = z.infer<typeof ingredientId>;

export const [productId, unsafeProductId] = brandedId("ProductId");
export type ProductId = z.infer<typeof productId>;

export const [locationId, unsafeLocationId] = brandedId("LocationId");
export type LocationId = z.infer<typeof locationId>;

export const [inventoryId, unsafeInventoryId] = brandedId("InventoryId");
export type InventoryId = z.infer<typeof inventoryId>;

export const [cookbookId, unsafeCookbookId] = brandedId("CookbookId");
export type CookbookId = z.infer<typeof cookbookId>;

export const [mealId, unsafeMealId] = brandedId("MealId");
export type MealId = z.infer<typeof mealId>;

export const [mealRecipeId, unsafeMealRecipeId] = brandedId("MealRecipeId");
export type MealRecipeId = z.infer<typeof mealRecipeId>;

export const [projectId, unsafeProjectId] = brandedId("ProjectId");
export type ProjectId = z.infer<typeof projectId>;

export const [taskId, unsafeTaskId] = brandedId("TaskId");
export type TaskId = z.infer<typeof taskId>;

export const [expenseId, unsafeExpenseId] = brandedId("ExpenseId");
export type ExpenseId = z.infer<typeof expenseId>;

export const [financialAccountId, unsafeFinancialAccountId] =
  brandedId("FinancialAccountId");
export type FinancialAccountId = z.infer<typeof financialAccountId>;

export const [financialTransactionId, unsafeFinancialTransactionId] = brandedId(
  "FinancialTransactionId",
);
export type FinancialTransactionId = z.infer<typeof financialTransactionId>;

export const [vendorId, unsafeVendorId] = brandedId("VendorId");
export type VendorId = z.infer<typeof vendorId>;

// The vendor purchase event an expense belongs to. `PurchaseId` used to brand
// the ledger row itself; that row is now `ExpenseId`.
export const [purchaseId, unsafePurchaseId] = brandedId("PurchaseId");
export type PurchaseId = z.infer<typeof purchaseId>;

export const [wishId, unsafeWishId] = brandedId("WishId");
export type WishId = z.infer<typeof wishId>;

// Shortcode schemas re-exported from the shared package (single source of
// truth). Each one already trims, uppercases, validates its prefix, and brands —
// there is deliberately no second "normalized" variant to choose between.
export {
  anyShortcodeSchema,
  cookbookShortcode,
  expenseShortcode,
  financialAccountShortcode,
  financialTransactionShortcode,
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  recipeShortcode,
  shortcodeSchema,
  taskShortcode,
  vendorShortcode,
  wishShortcode,
} from "@cubby/shared";
export type {
  CookbookShortcode,
  ExpenseShortcode,
  FinancialAccountShortcode,
  FinancialTransactionShortcode,
  IngredientShortcode,
  InventoryShortcode,
  LocationShortcode,
  MealShortcode,
  ProductShortcode,
  ProjectShortcode,
  PurchaseShortcode,
  RecipeShortcode,
  TaskShortcode,
  VendorShortcode,
  WishShortcode,
};

export const unsafeCookbookShortcode = makeUnsafeId<CookbookShortcode>();
export const unsafeExpenseShortcode = makeUnsafeId<ExpenseShortcode>();
export const unsafeFinancialAccountShortcode =
  makeUnsafeId<FinancialAccountShortcode>();
export const unsafeFinancialTransactionShortcode =
  makeUnsafeId<FinancialTransactionShortcode>();
export const unsafeIngredientShortcode = makeUnsafeId<IngredientShortcode>();
export const unsafeInventoryShortcode = makeUnsafeId<InventoryShortcode>();
export const unsafeLocationShortcode = makeUnsafeId<LocationShortcode>();
export const unsafeMealShortcode = makeUnsafeId<MealShortcode>();
export const unsafeProductShortcode = makeUnsafeId<ProductShortcode>();
export const unsafeProjectShortcode = makeUnsafeId<ProjectShortcode>();
export const unsafePurchaseShortcode = makeUnsafeId<PurchaseShortcode>();
export const unsafeRecipeShortcode = makeUnsafeId<RecipeShortcode>();
export const unsafeTaskShortcode = makeUnsafeId<TaskShortcode>();
export const unsafeVendorShortcode = makeUnsafeId<VendorShortcode>();
export const unsafeWishShortcode = makeUnsafeId<WishShortcode>();
