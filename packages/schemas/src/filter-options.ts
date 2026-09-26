import { z } from "zod";
import { entitySchema, type Entity } from "./entity";
import { shortcodeEntities, type ShortcodeEntity } from "./entity-manifest";
import { imageUrlSummary } from "./image-summary";
import { plainDate } from "./base-entity";
import { expenseShortcode } from "./identifiers";
import { ledgerPartyKind } from "./ledger-party-fields";

export const filterOptionKind = z.enum([
  "ingredientWithProduct",
  "locationIdentityProduct",
  "locationWithInventory",
  "product",
  "project",
  "task",
  "vendor",
]);
export type FilterOptionKind = z.infer<typeof filterOptionKind>;

const filterOptionRequest = z.object({
  search: z.string().trim().max(100).default(""),
  cursor: z.string().regex(/^\d+$/u).optional(),
  selectedIds: z.array(z.string().min(1)).max(50).default([]),
  limit: z.number().int().min(1).max(50).default(25),
});
const isShortcodeEntity = (entity: Entity): entity is ShortcodeEntity =>
  shortcodeEntities.some((candidate) => candidate === entity);
export const filterOptionEntity = entitySchema.refine(
  isShortcodeEntity,
  "must identify an entity with public shortcodes",
);
const kindFilterOptionsInput = filterOptionRequest.extend({
  // Optional for wire compatibility with the existing scoped roster request.
  source: z.literal("kind").optional(),
  kind: filterOptionKind,
});
const filterOptionProjection = z.enum([
  "count",
  "logo",
  "kind",
  "icon",
  "dates",
]);
export type FilterOptionProjection = z.infer<typeof filterOptionProjection>;

const entityFilterOptionsInput = filterOptionRequest.extend({
  source: z.literal("entity"),
  entity: filterOptionEntity,
  /**
   * Optional per-row projections. `count` also orders the roster by it,
   * descending — the "most used first" order a picker wants.
   */
  include: z.array(filterOptionProjection).max(5).default([]),
  // A picker that filters client-side reads its whole roster in one page.
  limit: z.number().int().min(1).max(1000).default(25),
  /**
   * Excludes one expense's own current allocation from the `dates`
   * projection's effective-window computation (project picker suggestions
   * while editing that expense must not treat its own not-yet-saved
   * allocation as evidence of a project's window).
   */
  excludeExpenseId: expenseShortcode.optional(),
});

/**
 * A tag roster, keyed by the entity whose free-text `tags` column is being
 * enumerated. Recipe tags are a plain distinct list; product tags carry usage
 * counts (via `include: ["count"]`-shaped output — always populated, not
 * gated behind `include`, since the picker label needs it to tell near-dup
 * tags apart).
 */
const tagsFilterOptionsInput = filterOptionRequest.extend({
  source: z.literal("tags"),
  entity: z.enum(["recipe", "product"]),
  limit: z.number().int().min(1).max(1000).default(25),
});

export const filterOptionsInput = z.union([
  kindFilterOptionsInput,
  entityFilterOptionsInput,
  tagsFilterOptionsInput,
]);
export type FilterOptionsInput = z.infer<typeof filterOptionsInput>;

export const filterOptionItem = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  /** Present when requested through `include` (or always, for a tags roster
   * over an entity whose tags carry usage counts). */
  count: z.number().int().optional(),
  logo: imageUrlSummary.nullable().optional(),
  /** Present when requested through `include` (`ledgerParty`'s kind). */
  kind: ledgerPartyKind.optional(),
  /** Present when requested through `include` (an entity's own icon, e.g. `project`). */
  icon: z.string().nullable().optional(),
  /**
   * Present when requested through `include` (`project`'s effective content
   * window — see `projectNameOptions`).
   */
  dates: z
    .object({
      effectiveStart: plainDate.nullable(),
      effectiveEnd: plainDate.nullable(),
    })
    .optional(),
});
export type FilterOptionItem = z.infer<typeof filterOptionItem>;

export const filterOptionsOut = z.object({
  items: z.array(filterOptionItem),
  nextCursor: z.string().nullable(),
});
export type FilterOptionsOut = z.infer<typeof filterOptionsOut>;
