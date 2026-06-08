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
  "usda-food",
  "image",
]);
export type Entity = z.infer<typeof entitySchema>;
