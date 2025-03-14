import { type Amount } from "~/codec/codec";
import {
  type InfLocationConfig,
  type ProductConfigItem,
} from "~/schemas/config";
import { type LocationType } from "~/schemas/location";
import { type UnitMapping } from "~/schemas/unitmapping";

// amount from unit and value
export const uv = (value: number, unit: string): Amount => ({ unit, value });
// unit mappings from unit value pair
export const uvp = (
  valueA: number,
  unitA: string,
  valueB: number,
  unitB: string,
  source: string,
): UnitMapping => ({
  a: uv(valueA, unitA),
  b: uv(valueB, unitB),
  source: source,
});
// generic product
export const gp = (name: string): ProductConfigItem => ({
  name,
  manufacturer: "generic",
});
// product (non-ingredient)
export const p = (
  name: string,
  upc: string,
  manufacturer: string,
  model: string,
  price_per: number,
): ProductConfigItem => ({
  name,
  manufacturer,
  upc,
  model,
  price_per,
});
// product (ingredient)
export const i = (
  name: string,
  upc: string,
  manufacturer: string,
  unit_mappings: UnitMapping[],
): ProductConfigItem => ({
  name,
  ingredient: true,
  manufacturer,
  upc,
  unit_mappings,
});
// product (generic ingredient
export const gi = (
  name: string,
  ndb_number: number | undefined,
  unit_mappings: UnitMapping[],
): ProductConfigItem => ({
  name,
  ingredient: true,
  manufacturer: "generic",
  unit_mappings,
  ndb_number,
});
// location
export const lp = (
  name: string,
  type: LocationType,
  products: ProductConfigItem[],
): InfLocationConfig => ({
  name,
  type,
  products,
});
export const lc = (
  name: string,
  type: LocationType,
  children: InfLocationConfig[],
): InfLocationConfig => ({
  name,
  type,
  children,
});
