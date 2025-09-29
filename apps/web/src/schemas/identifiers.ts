import { z } from "zod";

// Generic entity ID (use sparingly - prefer specific branded types)
export const id = z.uuid().describe("entity identifier");

// Branded ID types for type safety
export const projectId = z.uuid().brand("ProjectId");
export const userId = z.string().brand("UserId");
export const recipeId = z.uuid().brand("RecipeId");
export const ingredientId = z.uuid().brand("IngredientId");
export const productId = z.uuid().brand("ProductId");
export const locationId = z.uuid().brand("LocationId");
export const inventoryId = z.uuid().brand("InventoryId");

// Type exports
export type ProjectId = z.infer<typeof projectId>;
export type UserId = z.infer<typeof userId>;
export type RecipeId = z.infer<typeof recipeId>;
export type IngredientId = z.infer<typeof ingredientId>;
export type ProductId = z.infer<typeof productId>;
export type LocationId = z.infer<typeof locationId>;
export type InventoryId = z.infer<typeof inventoryId>;

// Helper functions for unsafe casts (use only when you're certain the value is valid)
// These are useful in tests and when working with external data that you know is valid
export const unsafeProjectId = (id: string): ProjectId => id as ProjectId;
export const unsafeUserId = (id: string): UserId => id as UserId;
export const unsafeRecipeId = (id: string): RecipeId => id as RecipeId;
export const unsafeIngredientId = (id: string): IngredientId =>
  id as IngredientId;
export const unsafeProductId = (id: string): ProductId => id as ProductId;
export const unsafeLocationId = (id: string): LocationId => id as LocationId;
export const unsafeInventoryId = (id: string): InventoryId => id as InventoryId;
