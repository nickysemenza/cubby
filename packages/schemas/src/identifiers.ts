import type { AppErrorReason } from "@cubby/shared";
import { z } from "zod";
import type { ShortcodeEntity } from "./entity-manifest";
import { entityNames } from "./generated/entity-names.gen";

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
} as const satisfies Record<ShortcodeEntity, (value: unknown) => EntityRef>;

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
 * Sentence-cases the Title Case name an entity's manifest literal declares
 * (`names.singular`), which is how a message that starts with the entity noun
 * reads: `"Financial account not found: FAC-4K7M"`.
 *
 * Only the first word survives capitalized, so an initialism keeps its own
 * casing when it leads (`"USDA Food"` → `"USDA food"`).
 */
const sentenceCaseEntityLabel = (entity: ShortcodeEntity): string =>
  entityNames[entity].singular
    .split(" ")
    .map((word, index) => (index === 0 ? word : word.toLowerCase()))
    .join(" ");

/**
 * Entity → the singular noun a not-found message calls it, sentence-cased for
 * use at the start of one (`"Financial account not found: FAC-4K7M"`).
 *
 * The companion to {@link ENTITY_NOT_FOUND_REASON}: that supplies a generic
 * resolver's error *code*, this supplies its *prose*. The keys are spelled out
 * so `satisfies` still fails to compile on a missing or invented entity; the
 * *values* all come from the entity literal's `names.singular`, so a rename
 * there propagates to server prose instead of drifting a second, hand-typed
 * copy out of sync.
 *
 * The client UI casts the same canonical string the other way, into Title Case
 * UI chrome (`titleCaseEntityLabel` in `apps/web/src/entities/entities.tsx`).
 * `inventory` reads `"Inventory item"`, not `"Inventory entry"`: the manifest's
 * own `names.singular`, the entity's nav/registry label, and its route-level
 * not-found copy all already said "item" — "entry" survives only in row-scoped
 * repo error strings (`InventoryEntry` is the table name) that are a different,
 * deliberately narrower case (see
 * `apps/web/src/app/inventory/inventoryitemlist.tsx`'s delete-dialog comment)
 * and aren't sourced from this map.
 */
export const ENTITY_LABEL = {
  cookbook: sentenceCaseEntityLabel("cookbook"),
  expense: sentenceCaseEntityLabel("expense"),
  financialAccount: sentenceCaseEntityLabel("financialAccount"),
  financialTransaction: sentenceCaseEntityLabel("financialTransaction"),
  image: sentenceCaseEntityLabel("image"),
  ingredient: sentenceCaseEntityLabel("ingredient"),
  inventory: sentenceCaseEntityLabel("inventory"),
  ledgerParty: sentenceCaseEntityLabel("ledgerParty"),
  ledgerTransfer: sentenceCaseEntityLabel("ledgerTransfer"),
  location: sentenceCaseEntityLabel("location"),
  meal: sentenceCaseEntityLabel("meal"),
  product: sentenceCaseEntityLabel("product"),
  project: sentenceCaseEntityLabel("project"),
  purchase: sentenceCaseEntityLabel("purchase"),
  recipe: sentenceCaseEntityLabel("recipe"),
  task: sentenceCaseEntityLabel("task"),
  vendor: sentenceCaseEntityLabel("vendor"),
  wish: sentenceCaseEntityLabel("wish"),
} satisfies Record<ShortcodeEntity, string>;
