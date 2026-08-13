import type { Entity } from "@cubby/schemas/entity";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRightLeft,
  ClipboardCheck,
  Plus,
  Printer,
  ScanBarcode,
  ShoppingCart,
  Sparkles,
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
  | "inventory-page"
  | "home-quick";

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
  /**
   * Search params to navigate with. Both surfaces use typed navigation
   * (`<Link to>` / `navigate({ to })`), which treats `path` as a pathname —
   * a query string embedded in `path` would never be parsed. The tracker
   * entities have no `/new` route (they create via a dialog on their index
   * page), so their actions deep-link with `{ create: true }` instead.
   */
  search?: Record<string, unknown>;
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
  // `home-quick` leads with the household's recurring verbs — recount, cook,
  // shop, triage — before any create form. The home card previously rendered
  // the navbar's create-only slice, which offers eight ways to add a record on
  // a database that is already populated; the daily job there is acting on
  // what exists. Order in this array is the order each surface renders.
  {
    id: "recount",
    name: "Recount",
    path: "/inventory/session",
    icon: ScanBarcode,
    keywords: ["barcode", "scan", "inventory", "add", "garage", "audit"],
    surfaces: [
      "navbar-create",
      "palette-quick",
      "inventory-page",
      "home-quick",
    ],
  },
  {
    id: "what-can-i-make",
    name: "What can I make?",
    path: "/meals/suggestions",
    icon: Sparkles,
    keywords: ["cook", "tonight", "recipe", "available", "pantry", "dinner"],
    surfaces: ["palette-quick", "home-quick"],
  },
  {
    id: "shopping-list",
    name: "Shopping list",
    path: "/meals/shopping-list",
    icon: ShoppingCart,
    keywords: ["shop", "buy", "groceries", "needs", "meal plan"],
    surfaces: ["palette-quick", "home-quick"],
  },
  entityCreate(
    "product",
    "add-product",
    Plus,
    ["navbar-create", "palette-quick", "home-quick"],
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
  // House-domain quick capture. No `entity` (that variant renders "New {label}"
  // pointing at `routes.new`, which these three deliberately don't have) — the
  // create dialog is opened by the `create` search param on each index page.
  {
    id: "add-task",
    name: "Add Task",
    path: entities.task.routes.list,
    search: { create: true },
    icon: entities.task.lucideIcon,
    keywords: ["create", "new", "todo", "house", "chore"],
    surfaces: ["navbar-create", "palette-quick", "home-quick"],
  },
  {
    id: "add-project",
    name: "Add Project",
    path: entities.project.routes.list,
    search: { create: true },
    icon: entities.project.lucideIcon,
    keywords: ["create", "new", "house", "renovation", "trade"],
    surfaces: ["navbar-create", "palette-quick"],
  },
  {
    id: "add-expense",
    name: "Add Expense",
    path: entities.expense.routes.list,
    search: { create: true },
    icon: entities.expense.lucideIcon,
    keywords: ["create", "new", "expense", "receipt", "spend", "cost"],
    surfaces: ["navbar-create", "palette-quick", "home-quick"],
  },
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
    surfaces: ["palette-quick", "home-quick"],
  },
  {
    id: "bulk-edit",
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
