import type { LucideIcon } from "lucide-react";

/** Typed routes for an entity */
interface EntityRoutes {
  /** Detail page route (e.g., "/products/$id") */
  detail: string;
  /** List page route (e.g., "/products") */
  list: string;
  /** "New" page route - optional since not all entities have one */
  new?: string;
}

/** Common section types that can be auto-generated for detail pages */
type CommonSectionType = "images" | "history" | "unit-mappings";

/** Standard column types that can be auto-included in list pages */
type StandardColumnType = "image" | "name";

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
}

/** Entity color classes for consistent visual identification */
interface EntityColor {
  /** CSS color token for inline accent variables */
  accent: string;
  /** Background color classes (e.g., "bg-blue-100") */
  bg: string;
  /** Text color classes (e.g., "text-blue-500") */
  text: string;
  /** Border color classes for entity-accented rows/cards */
  border: string;
}

/** Full entity definition including UI conventions */
export interface EntityDefinition {
  label: string;
  basePath: string;
  pluralLabel: string;
  /** Lucide icon component for UI elements */
  lucideIcon: LucideIcon;
  /** Color classes for visual entity identification */
  color: EntityColor;
  /** Typed routes for this entity */
  routes: EntityRoutes;
  /** Detail page conventions */
  detail?: EntityDetailConfig;
  /** List page conventions */
  list?: EntityListConfig;
}
