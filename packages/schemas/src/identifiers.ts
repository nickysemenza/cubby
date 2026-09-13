import type {
  AppErrorReason,
  ShortcodeType as ShortcodeEntity,
} from "@cubby/shared";
import { entityNames } from "./generated/entity-names.gen";
export * from "./identifier-fields";

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
  planting: "PLANTING_NOT_FOUND",
  gardenEntry: "GARDEN_ENTRY_NOT_FOUND",
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
  planting: sentenceCaseEntityLabel("planting"),
  gardenEntry: sentenceCaseEntityLabel("gardenEntry"),
} satisfies Record<ShortcodeEntity, string>;
