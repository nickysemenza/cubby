import type { LucideIcon } from "lucide-react";
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

/** Entity color classes for consistent visual identification */
interface EntityColor {
  /** Background color classes (e.g., "bg-blue-100") */
  bg: string;
  /** Text color classes (e.g., "text-blue-500") */
  text: string;
}

/** Full entity definition including UI conventions */
export interface EntityDefinition {
  label: string;
  basePath: string;
  pluralLabel: string;
  shortcut?: string;
  /** Lucide icon component for UI elements */
  lucideIcon: LucideIcon;
  /** Color classes for visual entity identification */
  color: EntityColor;
  /** Detail page conventions */
  detail?: EntityDetailConfig;
  /** List page conventions */
  list?: EntityListConfig;
}
