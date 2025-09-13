import {
  ProductReferenceItem,
  type InfLocationConfigInput,
  type ProductConfigItemInput,
} from "~/schemas/config";
import { type LocationType } from "~/schemas/location";

// generic product
export const genericProduct = (
  name: string,
  price_per: number,
): ProductConfigItemInput => ({
  name,
  manufacturer: "generic",
  price_per,
});
// product (non-ingredient)
export const product = (
  name: string,
  upc: string,
  manufacturer: string,
  model: string,
  price_per: number,
): ProductConfigItemInput => ({
  name,
  manufacturer,
  upc,
  model,
  price_per,
});
// product (ingredient)
export const productIngredient = (
  name: string,
  upc: string,
  manufacturer: string,
  unit_mappings?: string[],
  aliases?: string[],
): ProductConfigItemInput => ({
  name,
  ingredient: true,
  manufacturer,
  upc,
  unit_mappings,
  aliases,
});

export const productReference = (name: string): ProductReferenceItem => ({
  name,
});

// product (generic ingredient
export const productGenericIngredient = (
  name: string,
  ndb_number: number | undefined,
  unit_mappings: string[],
  aliases?: string[],
): ProductConfigItemInput => ({
  name,
  ingredient: true,
  manufacturer: "generic",
  unit_mappings,
  ndb_number,
  aliases,
});
// location
export const locationWithProducts = (
  name: string,
  type: LocationType,
  products?: ProductConfigItemInput[],
): InfLocationConfigInput => ({
  name,
  type,
  products,
});

export const locationWithProductReferences = (
  name: string,
  type: LocationType,
  productReferences: ProductReferenceItem[],
): InfLocationConfigInput => ({
  name,
  type,
  productReferences,
});
export const locationWithChildren = (
  name: string,
  type: LocationType,
  children?: InfLocationConfigInput[],
): InfLocationConfigInput => ({
  name,
  type,
  children,
});
