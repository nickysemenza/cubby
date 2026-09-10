import { z } from "zod";
import type { ShortcodeType as ShortcodeEntity } from "@cubby/shared";

export const id = z.uuid().describe("entity identifier");

const brandedId = <Name extends string>(name: Name) => z.uuid().brand(name);

// Branded ID types for type safety.
// Session ids are opaque strings rather than UUIDs, but they still parse at the
// auth/session seam and stay branded through the rest of the application.
export const userId = z.string().min(1).brand("UserId");
export type UserId = z.infer<typeof userId>;

export const recipeId = brandedId("RecipeId");
export type RecipeId = z.infer<typeof recipeId>;

export const imageId = brandedId("ImageId");
export type ImageId = z.infer<typeof imageId>;

export const ingredientId = brandedId("IngredientId");
export type IngredientId = z.infer<typeof ingredientId>;

export const productId = brandedId("ProductId");
export type ProductId = z.infer<typeof productId>;

export const locationId = brandedId("LocationId");
export type LocationId = z.infer<typeof locationId>;

export const inventoryId = brandedId("InventoryId");
export type InventoryId = z.infer<typeof inventoryId>;

export const cookbookId = brandedId("CookbookId");
export type CookbookId = z.infer<typeof cookbookId>;

export const mealId = brandedId("MealId");
export type MealId = z.infer<typeof mealId>;

export const ledgerPartyId = brandedId("LedgerPartyId");
export type LedgerPartyId = z.infer<typeof ledgerPartyId>;

export const expenseAttributionId = brandedId("ExpenseAttributionId");
export type ExpenseAttributionId = z.infer<typeof expenseAttributionId>;

export const ledgerTransferId = brandedId("LedgerTransferId");
export type LedgerTransferId = z.infer<typeof ledgerTransferId>;

export const mealRecipeId = brandedId("MealRecipeId");
export type MealRecipeId = z.infer<typeof mealRecipeId>;

/** Storage-only identity for a portion row; never exposed by meal APIs. */
export const mealRecipePortionId = brandedId("MealRecipePortionId");
export type MealRecipePortionId = z.infer<typeof mealRecipePortionId>;

export const projectId = brandedId("ProjectId");
export type ProjectId = z.infer<typeof projectId>;

export const taskId = brandedId("TaskId");
export type TaskId = z.infer<typeof taskId>;

export const expenseId = brandedId("ExpenseId");
export type ExpenseId = z.infer<typeof expenseId>;

export const financialAccountId = brandedId("FinancialAccountId");
export type FinancialAccountId = z.infer<typeof financialAccountId>;

export const financialTransactionId = brandedId("FinancialTransactionId");
export type FinancialTransactionId = z.infer<typeof financialTransactionId>;

export const vendorId = brandedId("VendorId");
export type VendorId = z.infer<typeof vendorId>;

export const purchaseId = brandedId("PurchaseId");
export type PurchaseId = z.infer<typeof purchaseId>;

export const wishId = brandedId("WishId");
export type WishId = z.infer<typeof wishId>;

/** Every local entity's private UUID schema, keyed by its manifest entity. */
export const ENTITY_ID_SCHEMA = {
  cookbook: cookbookId,
  expense: expenseId,
  financialAccount: financialAccountId,
  financialTransaction: financialTransactionId,
  image: imageId,
  ingredient: ingredientId,
  inventory: inventoryId,
  ledgerParty: ledgerPartyId,
  ledgerTransfer: ledgerTransferId,
  location: locationId,
  meal: mealId,
  product: productId,
  project: projectId,
  purchase: purchaseId,
  recipe: recipeId,
  task: taskId,
  vendor: vendorId,
  wish: wishId,
} as const satisfies Record<ShortcodeEntity, z.ZodType>;

/** The branded private UUID for one exact local entity. */
export type EntityId<E extends ShortcodeEntity> = z.infer<
  (typeof ENTITY_ID_SCHEMA)[E]
>;

/** The UUID schema for one entity, preserving its exact branded output. */
export const entityIdSchema = <E extends ShortcodeEntity>(
  entity: E,
): (typeof ENTITY_ID_SCHEMA)[E] => ENTITY_ID_SCHEMA[entity];

type AnyEntityId = {
  [E in ShortcodeEntity]: EntityId<E>;
}[ShortcodeEntity];

export function nonEmptyTuple<T>(values: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error("Expected at least one value");
  return [first, ...rest];
}

/** Parse an untrusted or storage-originated value into one entity's UUID brand. */
export function parseEntityId<E extends ShortcodeEntity>(
  entity: E,
  value: unknown,
): EntityId<E>;
export function parseEntityId(
  entity: ShortcodeEntity,
  value: unknown,
): AnyEntityId {
  return ENTITY_ID_SCHEMA[entity].parse(value);
}

/**
 * An internal private-UUID reference. This is separate from the public/general
 * `{ entityType, entityId }` wire shape in `entity.ts`, whose string value may
 * be a shortcode or a non-local identifier such as `usda-food`.
 */
export type EntityRef<E extends ShortcodeEntity = ShortcodeEntity> = {
  [K in E]: EntityRefFor<K>;
}[E];

export interface EntityRefFor<E extends ShortcodeEntity> {
  entity: E;
  id: EntityId<E>;
}

type ParsedEntityRef<E extends ShortcodeEntity, Schema extends z.ZodType> = {
  entity: E;
  id: z.output<Schema>;
};

type EntityRefParser = (value: unknown) => EntityRef;

const entityRefParser =
  <E extends ShortcodeEntity, Schema extends z.ZodType>(
    entity: E,
    schema: Schema,
  ) =>
  (value: unknown): ParsedEntityRef<E, Schema> => ({
    entity,
    id: schema.parse(value),
  });

const PARSE_ENTITY_REF = {
  cookbook: entityRefParser("cookbook", cookbookId),
  expense: entityRefParser("expense", expenseId),
  financialAccount: entityRefParser("financialAccount", financialAccountId),
  financialTransaction: entityRefParser(
    "financialTransaction",
    financialTransactionId,
  ),
  image: entityRefParser("image", imageId),
  ingredient: entityRefParser("ingredient", ingredientId),
  inventory: entityRefParser("inventory", inventoryId),
  ledgerParty: entityRefParser("ledgerParty", ledgerPartyId),
  ledgerTransfer: entityRefParser("ledgerTransfer", ledgerTransferId),
  location: entityRefParser("location", locationId),
  meal: entityRefParser("meal", mealId),
  product: entityRefParser("product", productId),
  project: entityRefParser("project", projectId),
  purchase: entityRefParser("purchase", purchaseId),
  recipe: entityRefParser("recipe", recipeId),
  task: entityRefParser("task", taskId),
  vendor: entityRefParser("vendor", vendorId),
  wish: entityRefParser("wish", wishId),
} as const satisfies Record<ShortcodeEntity, EntityRefParser>;

/** Parse and correlate an internal entity discriminator with its UUID brand. */
export function parseEntityRef<E extends ShortcodeEntity>(
  entity: E,
  value: unknown,
): EntityRef<E>;
export function parseEntityRef(
  entity: ShortcodeEntity,
  value: unknown,
): EntityRef {
  return PARSE_ENTITY_REF[entity](value);
}

// Shortcode schemas re-exported from the shared package (single source of
// truth). Each one already trims, uppercases, validates its prefix, and brands —
// there is deliberately no second "normalized" variant to choose between.
export {
  anyShortcodeSchema,
  cookbookShortcode,
  expenseShortcode,
  financialAccountShortcode,
  financialTransactionShortcode,
  imageShortcode,
  ingredientShortcode,
  inventoryShortcode,
  ledgerPartyShortcode,
  ledgerTransferShortcode,
  locationShortcode,
  mealShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  parseShortcodeFor,
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
  ImageShortcode,
  IngredientShortcode,
  InventoryShortcode,
  LedgerPartyShortcode,
  LedgerTransferShortcode,
  LocationShortcode,
  MealShortcode,
  ProductShortcode,
  ProjectShortcode,
  PurchaseShortcode,
  RecipeShortcode,
  ShortcodeFor,
  TaskShortcode,
  VendorShortcode,
  WishShortcode,
} from "@cubby/shared";
