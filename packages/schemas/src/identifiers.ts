import type {
  AppErrorReason,
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
  TaskShortcode,
  VendorShortcode,
  WishShortcode,
} from "@cubby/shared";
import { z } from "zod";
import type { ShortcodeEntity } from "./entity-manifest";

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

/**
 * The shape every `unsafe*Id` / `unsafe*Shortcode` has: takes an unbranded
 * string, returns the brand. Named (rather than inlined into `makeUnsafeId`'s
 * inferred return) so `unsafeIdForEntity` below can require exactly this type —
 * two structurally-identical-but-separately-written generic signatures don't
 * compare equal once `RejectBranded<T>` is deferred behind a second `T`.
 */
type UnsafeIdCast<Branded> = <T extends string>(
  id: T & RejectBranded<T>,
) => Branded;

/** Type-guarded unsafe-cast factory: same guard shape as every hand-written `unsafe*Id`. */
function makeUnsafeId<Branded>(): UnsafeIdCast<Branded> {
  // `id` is contextually typed by `UnsafeIdCast` — re-annotating it here would
  // make this a second, separately-written generic signature, which does NOT
  // compare equal to the alias (see the note on `UnsafeIdCast`).
  return (id) => unsafeId<Branded>(id);
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

export const [imageId, unsafeImageId] = brandedId("ImageId");
export type ImageId = z.infer<typeof imageId>;

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

export const [ledgerPartyId, unsafeLedgerPartyId] = brandedId("LedgerPartyId");
export type LedgerPartyId = z.infer<typeof ledgerPartyId>;

export const [expenseAttributionId, unsafeExpenseAttributionId] = brandedId(
  "ExpenseAttributionId",
);
export type ExpenseAttributionId = z.infer<typeof expenseAttributionId>;

export const [ledgerTransferId, unsafeLedgerTransferId] =
  brandedId("LedgerTransferId");
export type LedgerTransferId = z.infer<typeof ledgerTransferId>;

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
export const unsafeImageShortcode = makeUnsafeId<ImageShortcode>();
export const unsafeIngredientShortcode = makeUnsafeId<IngredientShortcode>();
export const unsafeInventoryShortcode = makeUnsafeId<InventoryShortcode>();
export const unsafeLedgerPartyShortcode = makeUnsafeId<LedgerPartyShortcode>();
export const unsafeLedgerTransferShortcode =
  makeUnsafeId<LedgerTransferShortcode>();
export const unsafeLocationShortcode = makeUnsafeId<LocationShortcode>();
export const unsafeMealShortcode = makeUnsafeId<MealShortcode>();
export const unsafeProductShortcode = makeUnsafeId<ProductShortcode>();
export const unsafeProjectShortcode = makeUnsafeId<ProjectShortcode>();
export const unsafePurchaseShortcode = makeUnsafeId<PurchaseShortcode>();
export const unsafeRecipeShortcode = makeUnsafeId<RecipeShortcode>();
export const unsafeTaskShortcode = makeUnsafeId<TaskShortcode>();
export const unsafeVendorShortcode = makeUnsafeId<VendorShortcode>();
export const unsafeWishShortcode = makeUnsafeId<WishShortcode>();

// Entity → id lookups
//
// Everything above is written per-entity: sixteen `XxxId` types, sixteen
// `unsafeXxxId` functions. Code that only knows its entity as a VALUE (a generic
// shortcode resolver, a CRUD factory) can't reach any of them. These three
// lookups close that gap — one entry per `ShortcodeEntity`, i.e. exactly the
// entities that have a public id to resolve in the first place.

/**
 * The branded id TYPE of each entity. `entityManifest[e].idBrand` carries the
 * brand's NAME as a display string ("ProductId"); this carries the type itself.
 *
 * Not exported directly — `BrandForEntity` is the lookup callers want, and
 * keeping the table private means the only way to read it is through a key the
 * compiler has already checked against `ShortcodeEntity`.
 */
interface EntityIdBrand {
  cookbook: CookbookId;
  image: ImageId;
  expense: ExpenseId;
  financialAccount: FinancialAccountId;
  financialTransaction: FinancialTransactionId;
  ingredient: IngredientId;
  inventory: InventoryId;
  ledgerParty: LedgerPartyId;
  ledgerTransfer: LedgerTransferId;
  location: LocationId;
  meal: MealId;
  product: ProductId;
  project: ProjectId;
  purchase: PurchaseId;
  recipe: RecipeId;
  task: TaskId;
  vendor: VendorId;
  wish: WishId;
}

/**
 * `BrandForEntity<"product">` is `ProductId`. Lets a function generic over an
 * entity return that entity's branded id instead of a bare `string`.
 *
 * Drift-proof by construction: drop an entity from `EntityIdBrand` and this
 * declaration stops compiling, because `E` can no longer index the table.
 */
export type BrandForEntity<E extends ShortcodeEntity> = EntityIdBrand[E];

/**
 * One entity's unsafe-cast, indexed. Deliberately keeps the generic parameter of
 * the hand-written `unsafeXxxId`s rather than collapsing to `(id: string) =>
 * BrandForEntity<E>`: a `string` parameter would accept an already-branded value
 * and quietly defeat the no-op-cast guard for every caller that goes through the
 * map.
 */
type UnsafeIdFor<E extends ShortcodeEntity> = UnsafeIdCast<BrandForEntity<E>>;

/**
 * Entity → its branded-id constructor, the runtime half of `BrandForEntity`.
 * Needed because `unsafeProductId` and friends are sixteen separate functions:
 * a type-level lookup alone can't turn a uuid a resolver just read out of the
 * DB into `ProductId` at the value level.
 *
 * The value type is written in terms of `BrandForEntity<E>`, so the two halves
 * can't disagree — pairing an entity with another entity's brander is a compile
 * error here, not something the drift test has to notice at runtime.
 */
export const unsafeIdForEntity: {
  readonly [E in ShortcodeEntity]: UnsafeIdFor<E>;
} = {
  cookbook: unsafeCookbookId,
  image: unsafeImageId,
  expense: unsafeExpenseId,
  financialAccount: unsafeFinancialAccountId,
  financialTransaction: unsafeFinancialTransactionId,
  ingredient: unsafeIngredientId,
  inventory: unsafeInventoryId,
  ledgerParty: unsafeLedgerPartyId,
  ledgerTransfer: unsafeLedgerTransferId,
  location: unsafeLocationId,
  meal: unsafeMealId,
  product: unsafeProductId,
  project: unsafeProjectId,
  purchase: unsafePurchaseId,
  recipe: unsafeRecipeId,
  task: unsafeTaskId,
  vendor: unsafeVendorId,
  wish: unsafeWishId,
};

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
