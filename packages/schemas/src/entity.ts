import { z } from "zod";

// The polymorphic image `entityType` column values. These UPPERCASE storage
// keys are the image-bearing entities; the source of truth for WHICH entities
// have images is `imageEntities` in entity-manifest.ts (this module can't import
// it — that would cycle). entity-manifest.unit.test.ts asserts the two stay in
// sync, so flipping `hasImages` on the manifest forces an update here.
export const entityImage = z.enum([
  "PRODUCT",
  "LOCATION",
  "RECIPE",
  "COOKBOOK",
]);
export type EntityImage = z.infer<typeof entityImage>;

/** All entity types in the system */
export const entitySchema = z.enum([
  "ingredient",
  "product",
  "recipe",
  "cookbook",
  "location",
  "inventory",
  "meal",
  "usda-food",
  "image",
]);
export type Entity = z.infer<typeof entitySchema>;

export const entityRefFields = {
  entityType: entitySchema,
  entityId: z.string(),
};

export const entityRefSchema = z.object(entityRefFields);
export type EntityRef = z.infer<typeof entityRefSchema>;
