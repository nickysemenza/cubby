import { z } from "zod";
import { entitySchema, type Entity } from "./entity-core";
import { imageEntities } from "./entity-manifest";

export { entitySchema, type Entity } from "./entity-core";

// The polymorphic image `entityType` column values. These UPPERCASE storage
// keys are the image-bearing entities. `entity-manifest.ts` imports `Entity`
// above as a type only, so deriving this runtime roster has no module cycle.
type EntityImageValue = Uppercase<(typeof imageEntities)[number]>;
const entityImageValues = imageEntities.map((entity) =>
  entity.toUpperCase(),
) as [EntityImageValue, ...EntityImageValue[]];
export const entityImage = z.enum(entityImageValues);
export type EntityImage = z.infer<typeof entityImage>;

/** Stable key for a polymorphic entity reference. */
export const entityRefKey = (entity: Entity, id: string): string =>
  `${entity}:${id}`;

export const entityRefFields = {
  entityType: entitySchema,
  entityId: z.string(),
};

export const entityRefSchema = z.object(entityRefFields);
export type EntityRef = z.infer<typeof entityRefSchema>;
