import { z } from "zod";

export const entityImage = z.enum(["PRODUCT", "LOCATION", "RECIPE"]);
export type EntityImage = z.infer<typeof entityImage>;

export type Entity =
  | "ingredient"
  | "product"
  | "recipe"
  | "location"
  | "inventory-item"
  | "usda-food"
  | "image";
