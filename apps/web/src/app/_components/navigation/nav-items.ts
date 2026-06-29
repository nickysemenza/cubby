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
  ChefHat,
  Database,
  FileText,
  Hammer,
  Home,
  LayoutDashboard,
  ListChecks,
  MoreHorizontal,
  Network,
  Package,
  Palette,
  Plug,
  QrCode,
  ScanBarcode,
  Search,
  Settings,
  ShoppingCart,
  Sparkles,
  TrendingUp,
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
  icon: React.ComponentType<{ className?: string }>;
};

/** A dropdown that nests leaves. Discriminated from {@link NavItem} by `children`. */
export type NavGroup = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: NavItem[];
};

type NavNode = NavItem | NavGroup;

export const isNavGroup = (node: NavNode): node is NavGroup =>
  "children" in node;

// The handful of leaves shared across surfaces that aren't derived from the
// desktop tree (top-level desktop + bottom tabs / public bar). Everything else
// is inlined where it's used.
const home: NavItem = { to: "/", label: "Home", icon: Home };
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

/**
 * The signed-in desktop bar, top to bottom — the single source of truth for the
 * authed IA. Dropdowns nest their leaves and own their trigger icon. Active
 * state is derived (see {@link findActiveTo}), so nothing carries match logic.
 *
 * `Dev` is intentionally always present — cubby is a personal tool, so there's
 * no feature flag or DEV gate on the developer group.
 */
export const desktopNav: NavNode[] = [
  {
    label: "Cook",
    icon: ChefHat,
    children: [
      recipes,
      { to: "/cookbooks", label: "Cookbooks", icon: BookOpen },
      { to: "/meals/suggestions", label: "What can I make?", icon: Sparkles },
    ],
  },
  {
    label: "Pantry",
    icon: Boxes,
    children: [
      inventory,
      locations,
      { to: "/pantry-view", label: "Pantry view", icon: Package },
    ],
  },
  {
    label: "Plan",
    icon: CalendarRange,
    children: [
      { to: "/meals", label: "Meals", icon: Utensils },
      {
        to: "/meals/shopping-list",
        label: "Shopping list",
        icon: ShoppingCart,
      },
    ],
  },
  {
    label: "Reports",
    icon: LayoutDashboard,
    children: [
      { to: "/insights", label: "Insights", icon: TrendingUp },
      { to: "/activity", label: "Activity", icon: Activity },
    ],
  },
  {
    // Data surfaces — the reference/admin tables behind the workflows above.
    // Pulled out of Pantry/Reports/Dev where they were miscategorized.
    label: "Data",
    icon: Database,
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
    children: [
      {
        to: "/inventory/session",
        label: "Inventory Session",
        icon: ScanBarcode,
      },
      { to: "/labels", label: "Labels", icon: QrCode },
      { to: "/ask", label: "Ask AI", icon: Bot },
      { to: "/search", label: "Search", icon: Search },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
  {
    label: "Dev",
    icon: Wrench,
    children: [
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
      { to: "/projects", label: "Projects", icon: Hammer },
      { to: "/design", label: "Design", icon: Palette },
      { to: "/ai-smoke-test", label: "AI smoke test", icon: Sparkles },
      { to: "/ai-usage", label: "AI usage", icon: Bot },
      { to: "/search/debug", label: "Search debug", icon: Search },
      { to: "/background-jobs", label: "Background jobs", icon: Database },
      { to: "/mcp", label: "MCP tools", icon: Plug },
    ],
  },
];

/** Every authed leaf, flattened out of the tree (groups expanded). */
export const desktopLeaves: NavItem[] = desktopNav.flatMap((node) =>
  isNavGroup(node) ? node.children : [node],
);

/** Mobile bottom tabs (primary). `scan`/`search` are mobile-only shortcuts. */
export const bottomNavItems: NavItem[] = [
  {
    to: "/inventory/session",
    label: "Session",
    icon: ScanBarcode,
  },
  inventory,
  locations,
  recipes,
  { to: "/search", label: "Search", icon: Search },
];

const bottomTabTargets = new Set(bottomNavItems.map((item) => item.to));

/**
 * Mobile "More" sheet — Home first (the desktop logo links home, but the mobile
 * bar has no logo, so Home would otherwise be unreachable), then every authed
 * leaf that isn't already a primary tab.
 */
export const moreNavItems: NavItem[] = [
  home,
  ...desktopLeaves.filter((leaf) => !bottomTabTargets.has(leaf.to)),
];

/** Signed-out bar / bottom tabs — always flat leaves (no dropdowns). */
export const publicNavItems: NavItem[] = [
  home,
  { to: "/docs", label: "Docs", icon: FileText },
  { to: "/design", label: "Design", icon: Palette },
];

// --- Derived active state ---------------------------------------------------

/** Every reachable nav target, deduped — the universe active matching resolves over. */
const allTargets: string[] = uniq(
  [...desktopLeaves, ...bottomNavItems, ...publicNavItems].map(
    (leaf) => leaf.to as string,
  ),
);

/**
 * The active target is the longest *segment* prefix of the pathname. The
 * `to === path || path.startsWith(`${to}/`)` test makes `/` exact for free
 * (`"/" + "/"` never prefixes a subpath), so no per-leaf match logic is needed.
 * Returns the matching `to`; consumers compare their own `to` against it.
 */
function findActiveTo(pathname: string): string | undefined {
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
