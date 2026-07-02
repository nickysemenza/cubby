import type { Entity } from "@cubby/schemas/entity";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRightLeft,
  ClipboardCheck,
  Plus,
  Printer,
  ScanBarcode,
} from "lucide-react";
import { entities } from "~/entities/entities";

/**
 * Surfaces that render quick actions. Deriving each surface's list from one
 * registry (below) is the same trick nav-items uses for `moreNavSections` — so
 * the navbar "+" menu and the command palette can't drift on which actions ship
 * or how they're labeled.
 */
export type ActionSurface =
  | "navbar-create"
  | "palette-quick"
  | "inventory-page";

/**
 * A single quick action. `entity` marks an entity-create action whose `name`
 * (label) and `path` (create route) are single-sourced from the entities
 * registry, so create copy/routes stay canonical. Non-entity actions carry
 * their own `name`/`path`. `keywords` feed the palette's client-side filter.
 */
export interface ActionItem {
  id: string;
  /** Set for entity-create actions — name/path derive from `entities[entity]`. */
  entity?: Entity;
  name: string;
  path: string;
  icon: LucideIcon;
  keywords?: string[];
  surfaces: ActionSurface[];
}

/**
 * Build an entity-create action, sourcing label + create route from the
 * entities registry. Keeps "New {label}" / `routes.new` single-sourced.
 */
function entityCreate(
  entity: Entity,
  id: string,
  icon: LucideIcon,
  surfaces: ActionSurface[],
  keywords?: string[],
): ActionItem {
  const def = entities[entity];
  return {
    id,
    entity,
    // Discovery wording — the navbar create menu renders its own "New {label}"
    // (see quick-actions-menu); this `name` is what the palette/search surface.
    name: `Add ${def.label}`,
    path: def.routes.new ?? `/${def.basePath}/new`,
    icon,
    keywords,
    surfaces,
  };
}

/**
 * The single canonical quick-action registry. Every surface derives its slice
 * from here via {@link actionsForSurface}. Entity-create actions read
 * label/route from the entities registry; New Ingredient is intentionally left
 * out of every create surface (dev-level, not a headline create).
 */
export const actionItems: ActionItem[] = [
  {
    id: "add-inventory",
    name: "Recount",
    path: "/inventory/session",
    icon: ScanBarcode,
    keywords: ["barcode", "scan", "inventory", "add", "garage", "audit"],
    surfaces: ["navbar-create", "palette-quick", "inventory-page"],
  },
  entityCreate(
    "product",
    "add-product",
    Plus,
    ["navbar-create", "palette-quick"],
    ["create", "new", "item"],
  ),
  entityCreate(
    "recipe",
    "add-recipe",
    entities.recipe.lucideIcon,
    ["navbar-create", "palette-quick"],
    ["create", "new", "cooking"],
  ),
  entityCreate(
    "location",
    "add-location",
    entities.location.lucideIcon,
    ["navbar-create", "palette-quick"],
    ["create", "new", "place", "room"],
  ),
  {
    id: "bulk-move",
    name: "Bulk Move Inventory",
    path: "/inventory/bulk-move",
    icon: ArrowRightLeft,
    keywords: ["move", "transfer", "relocate", "inventory"],
    surfaces: ["palette-quick"],
  },
  {
    id: "problems",
    name: "Problems",
    path: "/problems",
    icon: AlertTriangle,
    keywords: ["issues", "errors", "warnings", "audit"],
    surfaces: ["palette-quick"],
  },
  {
    id: "inventory-audit",
    name: "Bulk Edit",
    path: "/inventory/bulk-edit",
    icon: ClipboardCheck,
    keywords: ["audit", "bulk", "edit", "inventory", "review"],
    surfaces: ["palette-quick", "inventory-page"],
  },
  {
    id: "print-labels",
    name: "Print Labels",
    path: "/labels",
    icon: Printer,
    keywords: ["label", "print", "qr", "barcode", "sticker"],
    surfaces: ["palette-quick"],
  },
  {
    id: "single-item",
    name: "Single Item",
    path: "/inventory/new",
    icon: Plus,
    keywords: ["inventory", "add", "manual"],
    surfaces: ["inventory-page"],
  },
];

/** The ordered slice of actions that a given surface renders. */
export function actionsForSurface(surface: ActionSurface): ActionItem[] {
  return actionItems.filter((action) => action.surfaces.includes(surface));
}
