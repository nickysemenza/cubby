import {
  SHORTCODE_TYPES,
  entityNotFoundReason,
  mapRecord,
} from "@cubby/shared";
import type {
  AppErrorReason,
  ShortcodeType as ShortcodeEntity,
} from "@cubby/shared";
import { entitySummary } from "./generated/entity-summary.gen";
export * from "./identifier-fields";

/**
 * Entity → the `AppErrorReason` thrown when one of its ids or shortcodes names
 * nothing live. Lets a generic "resolve or 404" helper raise the same reason the
 * hand-rolled per-entity lookups raise.
 *
 * Derived, not spelled out: `entityNotFoundReason` snake-expands camelCase
 * (`financialAccount` → `FINANCIAL_ACCOUNT_NOT_FOUND`) with a template-literal
 * type, so each value is a literal — not a `string` — and `satisfies` still
 * fails to compile if a derived reason is not a key of `AppErrors` (the same
 * derivation populates `AppErrors`, so the two cannot drift).
 */
export const ENTITY_NOT_FOUND_REASON = mapRecord(
  SHORTCODE_TYPES,
  entityNotFoundReason,
) satisfies Record<ShortcodeEntity, AppErrorReason>;

/**
 * Sentence-cases the Title Case name an entity's manifest literal declares
 * (`names.singular`), which is how a message that starts with the entity noun
 * reads: `"Financial account not found: FAC-4K7M"`.
 *
 * Only the first word survives capitalized, so an initialism keeps its own
 * casing when it leads (`"USDA Food"` → `"USDA food"`).
 */
const sentenceCaseEntityLabel = (entity: ShortcodeEntity): string =>
  entitySummary[entity].singular
    .split(" ")
    .map((word, index) => (index === 0 ? word : word.toLowerCase()))
    .join(" ");

/**
 * Entity → the singular noun a not-found message calls it, sentence-cased for
 * use at the start of one (`"Financial account not found: FAC-4K7M"`).
 *
 * The companion to {@link ENTITY_NOT_FOUND_REASON}: that supplies a generic
 * resolver's error *code*, this supplies its *prose*. Keys come from the
 * shortcode registry and values from the entity literal's `names.singular`,
 * so a new entity or a rename propagates to server prose instead of drifting
 * a second, hand-typed copy out of sync.
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
export const ENTITY_LABEL = mapRecord(
  SHORTCODE_TYPES,
  sentenceCaseEntityLabel,
) satisfies Record<ShortcodeEntity, string>;
