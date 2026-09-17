import { z } from "zod";
import { entitySchema, type Entity } from "./entity";
import { shortcodeEntities, type ShortcodeEntity } from "./entity-manifest";

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
const entityFilterOptionsInput = filterOptionRequest.extend({
  source: z.literal("entity"),
  entity: filterOptionEntity,
});
export const filterOptionsInput = z.union([
  kindFilterOptionsInput,
  entityFilterOptionsInput,
]);
export type FilterOptionsInput = z.infer<typeof filterOptionsInput>;

export const filterOptionItem = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
});
export type FilterOptionItem = z.infer<typeof filterOptionItem>;

export const filterOptionsOut = z.object({
  items: z.array(filterOptionItem),
  nextCursor: z.string().nullable(),
});
export type FilterOptionsOut = z.infer<typeof filterOptionsOut>;
