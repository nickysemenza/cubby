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

/** Common section types that can be auto-generated for detail pages */
type CommonSectionType = "images" | "history" | "unit-mappings";

/** Standard column types that can be auto-included in list pages */
type StandardColumnType = "image" | "name" | "createdAt";

/** Detail page conventions for an entity */
interface EntityDetailConfig {
  /** Auto-include these common section types */
  commonSections?: CommonSectionType[];
}

/** List page conventions for an entity */
interface EntityListConfig {
  /** Include unit mappings column (triggers async loading) */
  hasUnitMappings?: boolean;
  /** Default sort column */
  defaultSort?: string;
  /** Auto-include these column types */
  standardColumns?: StandardColumnType[];
  /** Fields that can be sorted server-side. Used by both repo and UI as single source of truth. */
  sortableFields?: readonly string[];
}

/** Full entity definition including UI conventions */
export interface EntityDefinition {
  label: string;
  basePath: string;
  pluralLabel: string;
  shortcut?: string;
  icon: string;
  /** Detail page conventions */
  detail?: EntityDetailConfig;
  /** List page conventions */
  list?: EntityListConfig;
}
