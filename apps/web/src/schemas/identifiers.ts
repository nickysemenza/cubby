import { z } from "zod";

// Generic entity ID (use sparingly - prefer specific branded types)
export const id = z.uuid().describe("entity identifier");

// Branded ID types for type safety
// Not exported - used only for type inference
const _organizationId = z.uuid().brand("OrganizationId");
const _userId = z.string().brand("UserId");
export const recipeId = z.uuid().brand("RecipeId");
export const ingredientId = z.uuid().brand("IngredientId");
export const productId = z.uuid().brand("ProductId");
export const locationId = z.uuid().brand("LocationId");
export const inventoryId = z.uuid().brand("InventoryId");

// Type exports
export type OrganizationId = z.infer<typeof _organizationId>;
export type UserId = z.infer<typeof _userId>;
export type RecipeId = z.infer<typeof recipeId>;
export type IngredientId = z.infer<typeof ingredientId>;
export type ProductId = z.infer<typeof productId>;
export type LocationId = z.infer<typeof locationId>;
export type InventoryId = z.infer<typeof inventoryId>;

// Helper functions for unsafe casts (use only when you're certain the value is valid)
// These are useful in tests and when working with external data that you know is valid
const unsafeId = <T>(id: string): T => id as unknown as T;

export const unsafeOrganizationId = (id: string) =>
  unsafeId<OrganizationId>(id);
export const unsafeUserId = (id: string) => unsafeId<UserId>(id);
export const unsafeRecipeId = (id: string) => unsafeId<RecipeId>(id);
export const unsafeIngredientId = (id: string) => unsafeId<IngredientId>(id);
export const unsafeProductId = (id: string) => unsafeId<ProductId>(id);
export const unsafeLocationId = (id: string) => unsafeId<LocationId>(id);
export const unsafeInventoryId = (id: string) => unsafeId<InventoryId>(id);
