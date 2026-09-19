import type { Entity } from "@cubby/schemas/entity";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Plus,
  ShoppingCart,
  Sparkles,
} from "lucide-react";

import { entities, isBrowserRoutedEntity } from "~/entities/entities";

import { type ActionVerbId, verbDef } from "./action-verbs";

/**
 * Surfaces that render quick actions. Deriving each surface's list from one
 * registry (below) is the same trick nav-items uses for workspace destinations — so
 * the navbar "+" menu and the command palette can't drift on which actions ship
 * or how they're labeled.
 */
export type ActionSurface =
  | "navbar-create"
  | "palette-quick"
  | "inventory-page"
  | "home-quick"
  /**
   * A list's empty state. Declaring the create here is what lets an entity
   * whose create is a dialog offer a call-to-action at all — see
   * {@link createActionFor}. Nothing renders this slice directly; the empty
   * state resolves through the entity.
   */
  | "empty-state";

/**
 * A single quick action. `entity` marks an entity-create action whose `name`
 * (label) and `path` (create route) are single-sourced from the entities
 * registry, so create copy/routes stay canonical. Non-entity actions carry
 * their own `name`/`path`. `keywords` feed the palette's client-side filter.
 */
export interface ActionItem {
  id: string;
  /**
   * Set for actions that are also a registered verb — `name` and `icon` then
   * come from {@link verbDef}, never from a string written here. See
   * {@link verbAction}.
   */
  verb?: ActionVerbId;
  /** Set for entity-create actions — name/path derive from `entities[entity]`. */
  entity?: BrowserRoutedEntity;
  name: string;
  path: string;
  /**
   * Search params to navigate with. Both surfaces use typed navigation
   * (`<Link to>` / `navigate({ to })`), which treats `path` as a pathname —
   * a query string embedded in `path` would never be parsed. The tracker
   * entities have no `/new` route (they create via a dialog on their index
   * page), so their actions deep-link with `{ create: true }` instead.
   */
  search?: EntityCreateSearch;
  icon: LucideIcon;
  keywords?: string[];
  surfaces: ActionSurface[];
}

interface EntityCreateSearch {
  create: true;
}

/**
 * Build an entity-create action, sourcing label + create route from the
 * entities registry. Keeps "New {label}" / `routes.new` single-sourced.
 */
function entityCreate(
  entity: BrowserRoutedEntity,
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
    path:
      ("new" in def.routes ? def.routes.new : undefined) ??
      `/${def.basePath}/new`,
    icon,
    keywords,
    surfaces,
  };
}

/**
 * Build a quick action for a registered verb, sourcing label + icon from the
 * action-verb registry.
 *
 * Without this, the palette re-spells verbs the app already has words for, and
 * it did: "Bulk Edit" and "Print Labels" shipped here in Title Case against
 * `action-verbs.ts`'s documented sentence case, and Bulk edit carried
 * `ClipboardCheck` where the registry declares `SquarePen`. That is the exact
 * label-and-glyph drift `action-verbs.ts` was created to end — it had simply
 * never been connected to this registry.
 */
function verbAction(
  verb: ActionVerbId,
  id: string,
  path: string,
  surfaces: ActionSurface[],
  keywords?: string[],
): ActionItem {
  const { label, icon } = verbDef(verb);
  return { id, verb, name: label, path, icon, keywords, surfaces };
}

/**
 * The single canonical quick-action registry. Every surface derives its slice
 * from here via {@link actionsForSurface}. Entity-create actions read
 * label/route from the entities registry; New Ingredient is intentionally
 * kept off the navbar/palette (dev-level, not a headline create) but still
 * carries an `empty-state` entry below so its list's empty state resolves.
 */
export const actionItems: ActionItem[] = [
  // `home-quick` is deliberately only the four recurring household verbs.
  // Home is an operate surface, not an alternate create menu; new records
  // remain available from their lists, the command palette, and the masthead.
  // Order in this array is the order each surface renders.
  verbAction(
    "recount",
    "recount",
    "/inventory/session",
    ["navbar-create", "palette-quick", "inventory-page", "home-quick"],
    ["barcode", "scan", "inventory", "add", "garage", "audit"],
  ),
  // Same recurring-verb slot as Recount: both are passes you walk the house
  // with. Palette-only left the newest of the three queue passes reachable
  // from three places where recount had seven.
  verbAction(
    "photoPass",
    "photo-pass",
    "/locations/photo-pass",
    ["palette-quick", "home-quick"],
    ["photo", "camera", "picture", "location", "bin", "shelf"],
  ),
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
  // Dialog-created entities: no `/new` route, so the create is deep-linked with
  // `?create=true` on the index page. They still carry `entity` — the surfaces
  // read `path`/`search` off the item, so `entity` only supplies the icon and
  // the "New {label}" wording, and `createActionFor` can find them.
  {
    id: "add-location",
    entity: "location",
    name: "Add Location",
    path: entities.location.routes.list,
    search: { create: true },
    icon: entities.location.lucideIcon,
    keywords: ["create", "new", "place", "room"],
    surfaces: ["navbar-create", "palette-quick"],
  },
  {
    id: "add-task",
    entity: "task",
    name: "Add Task",
    path: entities.task.routes.list,
    search: { create: true },
    icon: entities.task.lucideIcon,
    keywords: ["create", "new", "todo", "house", "chore"],
    surfaces: ["navbar-create", "palette-quick"],
  },
  {
    id: "add-project",
    entity: "project",
    name: "Add Project",
    path: entities.project.routes.list,
    search: { create: true },
    icon: entities.project.lucideIcon,
    keywords: ["create", "new", "house", "renovation", "trade"],
    surfaces: ["navbar-create", "palette-quick"],
  },
  {
    id: "add-expense",
    entity: "expense",
    name: "Add Expense",
    path: entities.expense.routes.list,
    search: { create: true },
    icon: entities.expense.lucideIcon,
    keywords: ["create", "new", "expense", "receipt", "spend", "cost"],
    surfaces: ["navbar-create", "palette-quick"],
  },
  {
    id: "add-meal",
    entity: "meal",
    name: "Add Meal",
    path: entities.meal.routes.list,
    search: { create: true },
    icon: entities.meal.lucideIcon,
    keywords: ["create", "new", "plan", "dinner", "calendar"],
    surfaces: ["navbar-create", "palette-quick"],
  },
  // Dialog-created, but deliberately not offered in the navbar or palette —
  // these are created in the flow of working a list, not from a global menu.
  // They are here so the list empty states have somewhere to point.
  {
    id: "add-ingredient",
    entity: "ingredient",
    name: "Add Ingredient",
    path: entities.ingredient.routes.list,
    search: { create: true },
    icon: entities.ingredient.lucideIcon,
    surfaces: ["empty-state"],
  },
  {
    id: "add-vendor",
    entity: "vendor",
    name: "Add Vendor",
    path: entities.vendor.routes.list,
    search: { create: true },
    icon: entities.vendor.lucideIcon,
    surfaces: ["empty-state"],
  },
  {
    id: "add-vendor-account",
    entity: "vendorAccount",
    name: "Add Vendor Account",
    path: entities.vendorAccount.routes.list,
    search: { create: true },
    icon: entities.vendorAccount.lucideIcon,
    surfaces: ["empty-state"],
  },
  {
    id: "add-purchase",
    entity: "purchase",
    name: "Add Purchase",
    path: entities.purchase.routes.list,
    search: { create: true },
    icon: entities.purchase.lucideIcon,
    surfaces: ["empty-state"],
  },
  {
    id: "add-financial-account",
    entity: "financialAccount",
    name: "Add Account",
    path: entities.financialAccount.routes.list,
    search: { create: true },
    icon: entities.financialAccount.lucideIcon,
    surfaces: ["empty-state"],
  },
  {
    id: "add-financial-transaction",
    entity: "financialTransaction",
    name: "Add Transaction",
    path: entities.financialTransaction.routes.list,
    search: { create: true },
    icon: entities.financialTransaction.lucideIcon,
    surfaces: ["empty-state"],
  },
  {
    id: "add-wish",
    entity: "wish",
    name: "Add Wish",
    path: entities.wish.routes.list,
    search: { create: true },
    icon: entities.wish.lucideIcon,
    surfaces: ["empty-state"],
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
    surfaces: ["palette-quick"],
  },
  verbAction(
    "bulkEdit",
    "bulk-edit",
    "/inventory/bulk-edit",
    ["palette-quick", "inventory-page"],
    ["audit", "bulk", "edit", "inventory", "review"],
  ),
  verbAction(
    "printLabels",
    "print-labels",
    "/labels",
    ["palette-quick"],
    ["label", "print", "qr", "barcode", "sticker"],
  ),
  {
    id: "single-item",
    entity: "inventory",
    name: "Single Item",
    path: entities.inventory.routes.list,
    search: { create: true },
    icon: Plus,
    keywords: ["inventory", "add", "manual"],
    surfaces: ["inventory-page"],
  },
];

/** The ordered slice of actions that a given surface renders. */
export function actionsForSurface(surface: ActionSurface): ActionItem[] {
  return actionItems.filter((action) => action.surfaces.includes(surface));
}

/** Where an entity's create affordance lives, as typed navigation. */
export interface CreateTarget {
  to: string;
  search?: EntityCreateSearch;
}

/**
 * The canonical create destination for an entity, or null if it has none.
 *
 * Registry first, `routes.new` second. That order is the point: an entity whose
 * create is a dialog (`?create=true`) has no `/new` route, so anything reading
 * `routes.new` alone concludes it can't be created and silently drops its
 * call-to-action. That is exactly what the list empty states did — meal,
 * project and task each carried an `actionLabel` that could never render,
 * because the button was gated on a route they deliberately don't have.
 */
export function createActionFor(entity: Entity): CreateTarget | null {
  if (!isBrowserRoutedEntity(entity)) return null;
  const action = actionItems.find((item) => item.entity === entity);
  if (action) return { to: action.path, search: action.search };
  const routes = entities[entity].routes;
  const newRoute = "new" in routes ? routes.new : undefined;
  return newRoute ? { to: newRoute } : null;
}
