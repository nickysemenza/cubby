import type { Entity } from "@cubby/schemas/entity";
import { type LinkProps, useLocation } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BookOpen,
  Bot,
  Boxes,
  CalendarRange,
  Camera,
  ChefHat,
  CreditCard,
  Database,
  FileText,
  Home,
  House,
  Landmark,
  ListChecks,
  MoreHorizontal,
  Network,
  Package,
  Palette,
  Plug,
  QrCode,
  Receipt,
  ScanBarcode,
  Search,
  Settings,
  ShoppingCart,
  Sparkles,
  Utensils,
  Wrench,
} from "lucide-react";
import { useMemo } from "react";
import { entities } from "~/entities/entities";

/** A navigable destination. `to` is typed against the generated route tree. */
export type NavItem = {
  to: LinkProps["to"];
  /** Static search params — only the scanner shortcut needs these today. */
  search?: Record<string, unknown>;
  label: string;
  /**
   * Shorter text for the 144px sidebar rail only. The rail is a compact index
   * and its width is set by the longest label, but `label` is also what the
   * command palette lists AND what cmdk filters on — shortening it there would
   * delete the search terms ("background" would stop finding the jobs page).
   * So the rail reads this and everything else keeps `label`.
   */
  railLabel?: string;
  icon: React.ComponentType<{ className?: string }>;
};

/** A dropdown that nests leaves. Discriminated from {@link NavItem} by `children`. */
export type NavGroup = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: NavItem[];
  /** Presentation tier. The complete manifest stays semantic truth while each
   * shell chooses how much of it to expose at once. */
  tier: "primary" | "utility" | "developer";
  /**
   * Optional landing route for the group itself (a section overview page).
   * Most groups here are pure dropdown triggers with no page of their own —
   * leave unset. Consumers that link a group label (e.g. the list-page
   * eyebrow) treat an unset `to` as "no route" and render plain text.
   */
  to?: LinkProps["to"];
};

type NavNode = NavItem | NavGroup;

export const isNavGroup = (node: NavNode): node is NavGroup =>
  "children" in node;

export function navItemLinkProps(item: NavItem, active: boolean) {
  return {
    to: item.to,
    preload: "intent" as const,
    preloadDelay: 40,
    "aria-current": active ? ("page" as const) : undefined,
  };
}

// The handful of leaves shared across surfaces that aren't derived from the
// desktop tree (top-level desktop + bottom tabs / public bar). Everything else
// is inlined where it's used.
/** Home is a direct workspace destination rather than a grouped leaf. */
export const homeNavItem: NavItem = { to: "/", label: "Home", icon: Home };
const recipes: NavItem = {
  to: "/recipes",
  label: "Recipes",
  icon: entities.recipe.lucideIcon,
};
const locations: NavItem = {
  to: "/locations",
  label: "Locations",
  icon: entities.location.lucideIcon,
};
const inventory: NavItem = {
  to: "/inventory",
  label: "Inventory",
  icon: entities.inventory.lucideIcon,
};
const scan: NavItem = {
  to: "/scan",
  label: "Scan",
  icon: ScanBarcode,
};
export const settingsNavItem: NavItem = {
  to: "/settings",
  label: "Settings",
  icon: Settings,
};

/** Sidebar groups omit Settings because the workspace footer owns it. */
export function getSidebarGroupItems(group: NavGroup): NavItem[] {
  return group.children.filter((item) => item.to !== settingsNavItem.to);
}

/**
 * The signed-in desktop bar, top to bottom — the single source of truth for the
 * authed IA. Dropdowns nest their leaves and own their trigger icon. Active
 * state is derived (see {@link findActiveTo}), so nothing carries match logic.
 *
 * `Dev` is intentionally always present in the manifest — cubby is a personal
 * tool, so utility navigation and Cmd-K retain it without a production gate.
 */
export const desktopNav: NavNode[] = [
  {
    label: "Cook",
    icon: ChefHat,
    tier: "primary",
    children: [
      recipes,
      { to: "/cookbooks", label: "Cookbooks", icon: BookOpen },
      // Ingredients are daily cooking reference data, not a developer surface —
      // they live beside recipes/cookbooks rather than under Dev.
      {
        to: "/ingredients",
        label: "Ingredients",
        icon: entities.ingredient.lucideIcon,
      },
      { to: "/ingredients/workbench", label: "Workbench", icon: ListChecks },
      {
        to: "/ingredients/equivalences",
        label: "Equivalences",
        icon: ArrowLeftRight,
      },
      {
        to: "/meals/suggestions",
        label: "What can I make?",
        railLabel: "Cookable",
        icon: Sparkles,
      },
    ],
  },
  {
    label: "Pantry",
    icon: Boxes,
    tier: "primary",
    children: [
      inventory,
      locations,
      { to: "/collections", label: "Collections", icon: Palette },
      { to: "/pantry-view", label: "Pantry view", icon: Package },
    ],
  },
  {
    label: "Plan",
    icon: CalendarRange,
    tier: "primary",
    children: [
      { to: "/calendar", label: "Calendar", icon: CalendarRange },
      { to: "/meals", label: "Meals", icon: Utensils },
      {
        to: "/meals/shopping-list",
        label: "Shopping list",
        icon: ShoppingCart,
      },
      { to: "/wishes", label: "Wishlist", icon: entities.wish.lucideIcon },
    ],
  },
  {
    label: "House",
    icon: House,
    tier: "primary",
    children: [
      { to: "/projects", label: "Projects", icon: entities.project.lucideIcon },
      { to: "/projects/tools", label: "Tool usage", icon: Wrench },
      { to: "/tasks", label: "Tasks", icon: entities.task.lucideIcon },
    ],
  },
  {
    label: "Finance",
    icon: CreditCard,
    tier: "primary",
    children: [
      { to: "/expenses", label: "Expenses", icon: entities.expense.lucideIcon },
      {
        to: "/purchases",
        label: "Purchases",
        icon: entities.purchase.lucideIcon,
      },
      { to: "/vendors", label: "Vendors", icon: entities.vendor.lucideIcon },
      { to: "/people", label: "People", icon: entities.person.lucideIcon },
      { to: "/financial-accounts", label: "Accounts", icon: Landmark },
      {
        to: "/financial-transactions",
        label: "Transactions",
        icon: CreditCard,
      },
      {
        to: "/household-contribution",
        label: "Contribution ledger",
        railLabel: "Contributions",
        icon: ArrowLeftRight,
      },
      {
        to: "/statement-rows",
        label: "Statement Rows",
        railLabel: "Statements",
        icon: Receipt,
      },
    ],
  },
  {
    // Data surfaces — the reference/admin tables behind the workflows above.
    // Pulled out of Pantry/Dev where they were miscategorized. (The old
    // Reports group is gone: Insights folded into the home dashboard,
    // Activity moved to More.)
    label: "Data",
    icon: Database,
    tier: "utility",
    children: [
      { to: "/products", label: "Products", icon: entities.product.lucideIcon },
      { to: "/usda", label: "USDA", icon: entities["usda-food"].lucideIcon },
      { to: "/images", label: "Images", icon: entities.image.lucideIcon },
      { to: "/entities", label: "Entities", icon: Network },
      { to: "/problems", label: "Problems", icon: AlertTriangle },
    ],
  },
  {
    label: "More",
    icon: MoreHorizontal,
    tier: "utility",
    children: [
      scan,
      {
        to: "/inventory/session",
        label: "Recount",
        icon: ScanBarcode,
      },
      { to: "/locations/photo-pass", label: "Photo pass", icon: Camera },
      { to: "/activity", label: "Activity", icon: Activity },
      { to: "/labels", label: "Labels", icon: QrCode },
      { to: "/ask", label: "Ask AI", icon: Bot },
      { to: "/search", label: "Search", icon: Search },
      settingsNavItem,
    ],
  },
  {
    label: "Dev",
    icon: Wrench,
    tier: "developer",
    children: [
      { to: "/design", label: "Design", icon: Palette },
      { to: "/ai-smoke-test", label: "AI smoke test", icon: Sparkles },
      { to: "/ai-usage", label: "AI usage", icon: Bot },
      { to: "/search/debug", label: "Search debug", icon: Search },
      {
        to: "/background-jobs",
        label: "Background jobs",
        railLabel: "Jobs",
        icon: Database,
      },
      { to: "/mcp", label: "MCP tools", icon: Plug },
    ],
  },
];

/** Every authed leaf, flattened out of the tree (groups expanded). */
export const desktopLeaves: NavItem[] = desktopNav.flatMap((node) =>
  isNavGroup(node) ? node.children : [node],
);

/** Complete signed-in destination universe, including the direct Home leaf. */
export const completeNavLeaves: NavItem[] = [homeNavItem, ...desktopLeaves];

/** Tiered views derived from the canonical manifest. Never hand-copy leaves
 * into a second navigation tree: breadcrumbs, Cmd-K and shells must agree. */
export const primaryNavGroups = desktopNav.filter(
  (node): node is NavGroup => isNavGroup(node) && node.tier === "primary",
);
export const utilityNavGroups = desktopNav.filter(
  (node): node is NavGroup => isNavGroup(node) && node.tier === "utility",
);
export const developerNavGroups = desktopNav.filter(
  (node): node is NavGroup => isNavGroup(node) && node.tier === "developer",
);

function leafAt(to: LinkProps["to"]): NavItem {
  const item = desktopLeaves.find((leaf) => leaf.to === to);
  if (!item) throw new Error(`Navigation target ${String(to)} is missing`);
  return item;
}

/** Four household jobs that earn persistent desktop attention. */
export const todayNavItems: NavItem[] = [
  leafAt("/inventory/session"),
  leafAt("/meals/shopping-list"),
  leafAt("/projects"),
  leafAt("/problems"),
];

/** Secondary phone destinations shown before the deeper taxonomy. */
export const mobileHouseholdItems: NavItem[] = [
  homeNavItem,
  leafAt("/inventory/session"),
  leafAt("/locations"),
  leafAt("/calendar"),
  leafAt("/meals"),
  leafAt("/projects"),
  leafAt("/expenses"),
  leafAt("/problems"),
];

export const workspaceUtilitySections: NavSection[] = [
  ...utilityNavGroups.map((group) => ({
    title: group.label,
    items: getSidebarGroupItems(group),
  })),
  ...developerNavGroups.map((group) => ({
    title: group.label,
    items: group.children,
  })),
];

/** Four persistent task destinations; the More trigger is the fifth tab. */
export const bottomNavItems: NavItem[] = [
  { to: "/", label: "Today", icon: Home },
  inventory,
  scan,
  { to: "/search", label: "Search", icon: Search },
];

/** A labeled group of leaves in the mobile "More" sheet. */
export type NavSection = { title: string; items: NavItem[] };

/** Signed-out bar / bottom tabs — always flat leaves (no dropdowns). */
export const publicNavItems: NavItem[] = [
  homeNavItem,
  { to: "/docs", label: "Docs", icon: FileText },
];

/**
 * The top-level nav group an entity's list page lives under, derived from
 * {@link desktopNav} — the single source of truth for the IA. Matches the
 * entity's `routes.list` against each group's children so the group label
 * can never drift from the real nav (see the hand-kept map this replaced,
 * `ENTITY_NAV_GROUP` in page-hero.tsx, which fell out of sync with the Data/
 * Cook reorg noted above).
 *
 * Every entity's list route appears exactly once across {@link desktopNav}
 * (verified by `nav-items.unit.test.ts`), so this is unambiguous and needs no
 * fallback — an entity added to `entities.tsx` without a nav home is a bug the
 * test catches, not a case for `undefined` here to paper over silently.
 * Deliberately walks {@link desktopNav} directly rather than
 * {@link desktopLeaves}, which flattens groups away and drops the parent
 * reference this needs.
 */
export function getEntityNavGroup(entity: Entity): NavGroup | undefined {
  const listRoute = entities[entity].routes.list;
  return desktopNav.find(
    (node): node is NavGroup =>
      isNavGroup(node) && node.children.some((child) => child.to === listRoute),
  );
}

/** Every reachable nav target, deduped — the universe active matching resolves over. */
const allTargets: string[] = uniq(
  [...completeNavLeaves, ...bottomNavItems, ...publicNavItems].map(
    (leaf) => leaf.to as string,
  ),
);

/**
 * The active target is the longest *segment* prefix of the pathname. The
 * `to === path || path.startsWith(`${to}/`)` test makes `/` exact for free
 * (`"/" + "/"` never prefixes a subpath), so no per-leaf match logic is needed.
 * Returns the matching `to`; consumers compare their own `to` against it.
 */
export function findActiveTo(pathname: string): string | undefined {
  let best: string | undefined;
  for (const to of allTargets) {
    if (
      (pathname === to || pathname.startsWith(`${to}/`)) &&
      (best === undefined || to.length > best.length)
    ) {
      best = to;
    }
  }
  return best;
}

/** Reactive {@link findActiveTo} keyed on the current pathname. */
export function useActiveTo(): string | undefined {
  const pathname = useLocation().pathname;
  return useMemo(() => findActiveTo(pathname), [pathname]);
}
