import { z } from "zod";
import { SHORTCODE_TYPES, capitalize, mapRecord } from "@cubby/shared";
import type { ShortcodeType as ShortcodeEntity } from "@cubby/shared";

export const id = z.uuid().describe("entity identifier");

const brandedId = <Name extends string>(name: Name) => z.uuid().brand(name);

// Branded ID types for type safety.
// Session ids are opaque strings rather than UUIDs, but they still parse at the
// auth/session seam and stay branded through the rest of the application.
export const userId = z.string().min(1).brand("UserId");
export type UserId = z.infer<typeof userId>;

export const expenseAttributionId = brandedId("ExpenseAttributionId");
export type ExpenseAttributionId = z.infer<typeof expenseAttributionId>;

export const mealRecipeId = brandedId("MealRecipeId");
export type MealRecipeId = z.infer<typeof mealRecipeId>;

/** Meal-owned food entry identity, like a MealRecipe occurrence. */
export const mealFoodEntryId = brandedId("MealFoodEntryId");
export type MealFoodEntryId = z.infer<typeof mealFoodEntryId>;

/** Storage-only identity for a portion row; never exposed by meal APIs. */
export const mealRecipePortionId = brandedId("MealRecipePortionId");
export type MealRecipePortionId = z.infer<typeof mealRecipePortionId>;

/** The Zod brand an entity's private UUID carries: `product` → `ProductId`. */
type EntityIdBrand<E extends ShortcodeEntity> = `${Capitalize<E>}Id`;

const entityIdBrand = <E extends ShortcodeEntity>(
  entity: E,
): EntityIdBrand<E> => `${capitalize(entity)}Id`;

type EntityIdSchemaMap = {
  [E in ShortcodeEntity]: ReturnType<typeof brandedId<EntityIdBrand<E>>>;
};

/**
 * Every local entity's private UUID schema, keyed by its manifest entity and
 * built from the shortcode registry, so a new entity gets its branded id
 * without a line here. The per-entity `xId` exports below are these entries.
 */
export const ENTITY_ID_SCHEMA =
  // SAFETY: each entry is `brandedId(brand(entity))` for its own key, i.e.
  // exactly `EntityIdSchemaMap[entity]`; `.brand<B>()` is a deferred
  // conditional inside the closure, so the per-key correlation this
  // construction guarantees is asserted here and checked per entity by
  // identifier-fields.unit.test.ts.
  mapRecord(SHORTCODE_TYPES, (entity) =>
    brandedId(entityIdBrand(entity)),
  ) as EntityIdSchemaMap;

/** The branded private UUID for one exact local entity. */
export type EntityId<E extends ShortcodeEntity> = z.infer<
  (typeof ENTITY_ID_SCHEMA)[E]
>;

/** The UUID schema for one entity, preserving its exact branded output. */
export const entityIdSchema = <E extends ShortcodeEntity>(
  entity: E,
): (typeof ENTITY_ID_SCHEMA)[E] => ENTITY_ID_SCHEMA[entity];

// Named per-entity exports over the same map — the stable import surface.
export const recipeId = ENTITY_ID_SCHEMA.recipe;
export const imageId = ENTITY_ID_SCHEMA.image;
export const ingredientId = ENTITY_ID_SCHEMA.ingredient;
export const productCategoryId = ENTITY_ID_SCHEMA.productCategory;
export const productId = ENTITY_ID_SCHEMA.product;
export const locationId = ENTITY_ID_SCHEMA.location;
export const inventoryId = ENTITY_ID_SCHEMA.inventory;
export const cookbookId = ENTITY_ID_SCHEMA.cookbook;
export const mealId = ENTITY_ID_SCHEMA.meal;
export const ledgerPartyId = ENTITY_ID_SCHEMA.ledgerParty;
export const ledgerTransferId = ENTITY_ID_SCHEMA.ledgerTransfer;
export const projectId = ENTITY_ID_SCHEMA.project;
export const taskId = ENTITY_ID_SCHEMA.task;
export const expenseId = ENTITY_ID_SCHEMA.expense;
export const financialAccountId = ENTITY_ID_SCHEMA.financialAccount;
export const financialTransactionId = ENTITY_ID_SCHEMA.financialTransaction;
export const vendorId = ENTITY_ID_SCHEMA.vendor;
export const vendorAccountId = ENTITY_ID_SCHEMA.vendorAccount;
export const purchaseId = ENTITY_ID_SCHEMA.purchase;
export const wishId = ENTITY_ID_SCHEMA.wish;
export const plantingId = ENTITY_ID_SCHEMA.planting;
export const gardenEntryId = ENTITY_ID_SCHEMA.gardenEntry;

export type RecipeId = EntityId<"recipe">;
export type ImageId = EntityId<"image">;
export type IngredientId = EntityId<"ingredient">;
export type ProductCategoryId = EntityId<"productCategory">;
export type ProductId = EntityId<"product">;
export type LocationId = EntityId<"location">;
export type InventoryId = EntityId<"inventory">;
export type CookbookId = EntityId<"cookbook">;
export type MealId = EntityId<"meal">;
export type LedgerPartyId = EntityId<"ledgerParty">;
export type LedgerTransferId = EntityId<"ledgerTransfer">;
export type ProjectId = EntityId<"project">;
export type TaskId = EntityId<"task">;
export type ExpenseId = EntityId<"expense">;
export type FinancialAccountId = EntityId<"financialAccount">;
export type FinancialTransactionId = EntityId<"financialTransaction">;
export type VendorId = EntityId<"vendor">;
export type VendorAccountId = EntityId<"vendorAccount">;
export type PurchaseId = EntityId<"purchase">;
export type WishId = EntityId<"wish">;
export type PlantingId = EntityId<"planting">;
export type GardenEntryId = EntityId<"gardenEntry">;

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

type EntityRefParser<E extends ShortcodeEntity> = (
  value: unknown,
) => EntityRefFor<E>;

const entityRefParser =
  <E extends ShortcodeEntity>(entity: E): EntityRefParser<E> =>
  (value) => ({ entity, id: parseEntityId(entity, value) });

/**
 * One parser per entity, keyed by its own literal so the compiler verifies the
 * `{ entity, id }` correlation per key (see `PARSE_CANONICAL_SHORTCODE` in
 * @cubby/shared for why this cannot be a `mapRecord`). `satisfies` fails to
 * compile when an entity is missing.
 */
const PARSE_ENTITY_REF = {
  cookbook: entityRefParser("cookbook"),
  expense: entityRefParser("expense"),
  financialAccount: entityRefParser("financialAccount"),
  financialTransaction: entityRefParser("financialTransaction"),
  image: entityRefParser("image"),
  ingredient: entityRefParser("ingredient"),
  inventory: entityRefParser("inventory"),
  ledgerParty: entityRefParser("ledgerParty"),
  ledgerTransfer: entityRefParser("ledgerTransfer"),
  location: entityRefParser("location"),
  meal: entityRefParser("meal"),
  planting: entityRefParser("planting"),
  gardenEntry: entityRefParser("gardenEntry"),
  product: entityRefParser("product"),
  productCategory: entityRefParser("productCategory"),
  project: entityRefParser("project"),
  purchase: entityRefParser("purchase"),
  recipe: entityRefParser("recipe"),
  task: entityRefParser("task"),
  vendor: entityRefParser("vendor"),
  vendorAccount: entityRefParser("vendorAccount"),
  wish: entityRefParser("wish"),
} as const satisfies { [E in ShortcodeEntity]: EntityRefParser<E> };

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
  productCategoryShortcode,
  projectShortcode,
  purchaseShortcode,
  parseShortcodeFor,
  recipeShortcode,
  shortcodeSchema,
  taskShortcode,
  vendorShortcode,
  vendorAccountShortcode,
  wishShortcode,
  plantingShortcode,
  gardenEntryShortcode,
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
  ProductCategoryShortcode,
  ProjectShortcode,
  PurchaseShortcode,
  RecipeShortcode,
  ShortcodeFor,
  TaskShortcode,
  VendorShortcode,
  VendorAccountShortcode,
  WishShortcode,
} from "@cubby/shared";
