import { z } from "zod";

export const entityImage = z.enum(["PRODUCT", "LOCATION", "RECIPE"]);
export const entities = z.enum([
  "ingredient",
  "product",
  "recipe",
  "location",
  "inventory-item",
  "usda-food",
  "image",
]);
export type Entity = z.infer<typeof entities>;
export type EntityImage = z.infer<typeof entityImage>;
