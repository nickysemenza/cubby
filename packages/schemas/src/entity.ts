import { z } from "zod";

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
