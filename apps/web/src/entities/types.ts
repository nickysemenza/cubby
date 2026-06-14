import type { LucideIcon } from "lucide-react";

// Re-export entity types from @cubby/schemas for backward compatibility
export type { Entity } from "@cubby/schemas/entity";

/** All valid entity detail routes (e.g., /products/$id) */
export type EntityDetailRoute =
  | "/ingredients/$id"
  | "/products/$id"
  | "/recipes/$id"
  | "/cookbooks/$cookbookId"
  | "/locations/$id"
  | "/inventory/$id"
  | "/meals/$id"
  | "/usda/$id"
  | "/images/$id";

/** All valid entity list routes (e.g., /products) */
type EntityListRoute =
  | "/ingredients"
  | "/products"
  | "/recipes"
  | "/cookbooks"
  | "/locations"
  | "/inventory"
  | "/meals"
  | "/usda"
  | "/images";

/** All valid entity "new" routes (e.g., /products/new) */
type EntityNewRoute =
  | "/ingredients/new"
  | "/products/new"
  | "/recipes/new"
  | "/locations/new"
  | "/inventory/new"
  | "/meals/new";

/** Typed routes for an entity */
export interface EntityRoutes {
  /** Detail page route (e.g., "/products/$id") */
  detail: EntityDetailRoute;
  /** List page route (e.g., "/products") */
  list: EntityListRoute;
  /** "New" page route - optional since not all entities have one */
  new?: EntityNewRoute;
}

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
