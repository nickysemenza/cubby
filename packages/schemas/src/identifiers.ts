import type { AppErrorReason } from "@cubby/shared";
import { z } from "zod";
import type { ShortcodeEntity } from "./entity-manifest";

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

const entityRefParser =
  <E extends ShortcodeEntity, Schema extends z.ZodType>(
    entity: E,
    schema: Schema,
  ) =>
  (value: unknown): { entity: E; id: z.output<Schema> } => ({
    entity,
    id: schema.parse(value),
  });

// Every entity's ref parser is definitionally entityRefParser(entity,
// ENTITY_ID_SCHEMA[entity]) — looping over the already-complete id-schema
// registry keeps this in lockstep with ENTITY_ID_SCHEMA by construction.
const PARSE_ENTITY_REF = Object.fromEntries(
  (Object.keys(ENTITY_ID_SCHEMA) as ShortcodeEntity[]).map((entity) => [
    entity,
    entityRefParser(entity, ENTITY_ID_SCHEMA[entity]),
  ]),
) as Record<ShortcodeEntity, (value: unknown) => EntityRef>;

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

/**
 * Entity → the `AppErrorReason` thrown when one of its ids or shortcodes names
 * nothing live. Lets a generic "resolve or 404" helper raise the same reason the
 * hand-rolled per-entity lookups raise today.
 *
 * Spelled out rather than derived, because `${entity.toUpperCase()}_NOT_FOUND`
 * is wrong three times over: `inventory` throws `INVENTORY_NOT_FOUND` while its
 * table is `inventoryEntry`, and the two camelCase financial entities need snake
 * expansion (`financialAccount` → `FINANCIALACCOUNT_NOT_FOUND`, which is not a
 * key of `AppErrors` at all). Deriving would also lose the type: a template
 * string is a `string`, so it could only reach `createAppError` through a cast,
 * and `AppErrors[reason]` would then hand the error mapper an `undefined` code.
 *
 * `satisfies` does the checking: a missing entity, or a reason that isn't a real
 * `AppErrorReason`, fails to compile.
 */
export const ENTITY_NOT_FOUND_REASON = {
  cookbook: "COOKBOOK_NOT_FOUND",
  expense: "EXPENSE_NOT_FOUND",
  financialAccount: "FINANCIAL_ACCOUNT_NOT_FOUND",
  financialTransaction: "FINANCIAL_TRANSACTION_NOT_FOUND",
  image: "IMAGE_NOT_FOUND",
  ingredient: "INGREDIENT_NOT_FOUND",
  inventory: "INVENTORY_NOT_FOUND",
  ledgerParty: "LEDGER_PARTY_NOT_FOUND",
  ledgerTransfer: "LEDGER_TRANSFER_NOT_FOUND",
  location: "LOCATION_NOT_FOUND",
  meal: "MEAL_NOT_FOUND",
  product: "PRODUCT_NOT_FOUND",
  project: "PROJECT_NOT_FOUND",
  purchase: "PURCHASE_NOT_FOUND",
  recipe: "RECIPE_NOT_FOUND",
  task: "TASK_NOT_FOUND",
  vendor: "VENDOR_NOT_FOUND",
  wish: "WISH_NOT_FOUND",
} as const satisfies Record<ShortcodeEntity, AppErrorReason>;

/**
 * Entity → the singular noun a not-found message calls it, sentence-cased for
 * use at the start of one (`"Financial account not found: FAC-4K7M"`).
 *
 * The companion to {@link ENTITY_NOT_FOUND_REASON}: that supplies a generic
 * resolver's error *code*, this supplies its *prose*. Spelled out for the same
 * reason — capitalizing the entity key gets 12 of 15 right and mangles the rest
 * (`financialAccount` → `"FinancialAccount"`, `inventory` → `"Inventory"` where
 * every existing message says `"Inventory entry"`). These strings are taken
 * verbatim from the messages the hand-rolled lookups already throw, so
 * collapsing those onto a generic helper doesn't reword any user-facing error.
 */
export const ENTITY_LABEL = {
  cookbook: "Cookbook",
  expense: "Expense",
  financialAccount: "Financial account",
  financialTransaction: "Financial transaction",
  image: "Image",
  ingredient: "Ingredient",
  inventory: "Inventory entry",
  ledgerParty: "Ledger party",
  ledgerTransfer: "Ledger transfer",
  location: "Location",
  meal: "Meal",
  product: "Product",
  project: "Project",
  purchase: "Purchase",
  recipe: "Recipe",
  task: "Task",
  vendor: "Vendor",
  wish: "Wish",
} as const satisfies Record<ShortcodeEntity, string>;
