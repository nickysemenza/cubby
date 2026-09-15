import { z } from "zod";
import { entitySchema, type Entity } from "./entity-core";
import { imageEntities } from "./entity-manifest";
import { nonEmptyTuple } from "./identifiers";

export { entitySchema, type Entity } from "./entity-core";

// The polymorphic image `entityType` column values. These UPPERCASE storage
// keys are the image-bearing entities. `entity-manifest.ts` imports `Entity`
// above as a type only, so deriving this runtime roster has no module cycle.
type EntityImageValue = Uppercase<(typeof imageEntities)[number]>;
const isEntityImageValue = (value: string): value is EntityImageValue =>
  imageEntities.some((entity) => entity.toUpperCase() === value);
const entityImageValues = nonEmptyTuple<EntityImageValue>(
  imageEntities
    .map((entity) => entity.toUpperCase())
    .filter(isEntityImageValue),
);
export const entityImage = z.enum(entityImageValues);
export type EntityImage = z.infer<typeof entityImage>;

/**
 * Every entity with generic image storage of its own — gallery and cover.
 * Entities resolved only through relationships are not `entityImage` values.
 */
export type ImageEntity = (typeof imageEntities)[number];

/**
 * The polymorphic image `entityType` value for `entity`. Every `ImageEntity`
 * slug uppercases losslessly (`location` → `LOCATION`, `gardenEntry` →
 * `GARDENENTRY`) into a member of `entityImage`, so this is a total,
 * cast-free replacement for a caller's own `entity.toUpperCase() as EntityImage`.
 */
export const entityImageOf = (entity: ImageEntity): EntityImage =>
  entityImage.parse(entity.toUpperCase());

export const entityRefKey = (entity: Entity, id: string): string =>
  `${entity}:${id}`;

export const entityRefFields = {
  entityType: entitySchema,
  entityId: z.string(),
};

/**
 * General/public reference shape. `entityId` is intentionally a string: it can
 * carry a public shortcode and the roster includes non-local `usda-food`.
 * Internal UUID-only references use the correlated `EntityRef` from
 * `@cubby/schemas/identifiers` instead.
 */
export const entityRefSchema = z.object(entityRefFields);
export type EntityRef = z.infer<typeof entityRefSchema>;
