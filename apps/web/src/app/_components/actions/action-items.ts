import type { Entity } from "@cubby/schemas/entity";
import {
  browserRoutedEntities,
  type BrowserRoutedEntity,
} from "@cubby/schemas/entity-manifest";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { ShoppingCartIcon } from "@phosphor-icons/react/dist/csr/ShoppingCart";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import type { Icon } from "@phosphor-icons/react/lib";

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
  icon: Icon;
  keywords?: string[];
  surfaces: ActionSurface[];
}

interface EntityCreateSearch {
  create: true;
}

/**
 * Build an entity-create action from the generated route capability. The
 * manifest is the source of truth: dialog routes deep-link through the list,
 * while page routes use their generated `/new` route.
 */
function entityCreate(
  entity: BrowserRoutedEntity,
  surfaces: ActionSurface[] = ["navbar-create", "palette-quick"],
): ActionItem {
  const def = entities[entity];
  const { routes } = def;
  const create = "create" in routes ? routes.create : undefined;
  if (create === undefined) {
    throw new Error(`Entity ${entity} has no browser create capability`);
  }
  const dialog = create === "dialog";
  const newRoute = "new" in routes ? routes.new : undefined;
  return {
    id: `add-${entity}`,
    entity,
    name: `Add ${def.label}`,
    path: newRoute ?? routes.list,
    search: dialog ? { create: true } : undefined,
    icon: def.phosphorIcon,
    keywords: ["create", "new", def.label.toLocaleLowerCase()],
    surfaces,
  };
}

const genericEntityCreateActions = browserRoutedEntities
  .filter((entity) => "create" in entities[entity].routes)
  .map((entity) => entityCreate(entity));

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
 * from here via {@link actionsForSurface}. Entity-create actions come from
 * generated route capabilities, so adding a generic create route cannot be
 * forgotten in this menu.
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
    icon: SparkleIcon,
    keywords: ["cook", "tonight", "recipe", "available", "pantry", "dinner"],
    surfaces: ["palette-quick", "home-quick"],
  },
  {
    id: "shopping-list",
    name: "Shopping list",
    path: "/meals/shopping-list",
    icon: ShoppingCartIcon,
    keywords: ["shop", "buy", "groceries", "needs", "meal plan"],
    surfaces: ["palette-quick", "home-quick"],
  },
  ...genericEntityCreateActions,
  {
    id: "problems",
    name: "Problems",
    path: "/problems",
    icon: WarningIcon,
    keywords: ["issues", "errors", "warnings", "audit"],
    surfaces: ["palette-quick"],
  },
  verbAction(
    "printLabels",
    "print-labels",
    "/labels",
    ["palette-quick"],
    ["label", "print", "qr", "barcode", "sticker"],
  ),
  {
    id: "single-item",
    name: "Single Item",
    path: entities.inventory.routes.list,
    search: { create: true },
    icon: PlusIcon,
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
