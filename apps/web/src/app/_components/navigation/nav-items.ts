import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { BarcodeIcon as ScanBarcode } from "@phosphor-icons/react/dist/csr/Barcode";
import { DatabaseIcon as Database } from "@phosphor-icons/react/dist/csr/Database";
import { DotsThreeIcon as MoreHorizontal } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FileTextIcon as FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { GearIcon as Settings } from "@phosphor-icons/react/dist/csr/Gear";
import { HouseIcon as Home } from "@phosphor-icons/react/dist/csr/House";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { NetworkIcon as Network } from "@phosphor-icons/react/dist/csr/Network";
import { PaletteIcon as Palette } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugIcon as Plug } from "@phosphor-icons/react/dist/csr/Plug";
import { PulseIcon as Activity } from "@phosphor-icons/react/dist/csr/Pulse";
import { QrCodeIcon as QrCode } from "@phosphor-icons/react/dist/csr/QrCode";
import { RobotIcon as Bot } from "@phosphor-icons/react/dist/csr/Robot";
import { SparkleIcon as Sparkles } from "@phosphor-icons/react/dist/csr/Sparkle";
import { WarningIcon as AlertTriangle } from "@phosphor-icons/react/dist/csr/Warning";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import type { Icon } from "@phosphor-icons/react/lib";
import { type LinkProps, useLocation } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { useMemo } from "react";

import { entities } from "~/entities/entities";

import { activityViews, recordViews } from "./application-views";
import type { WayfindingDomain } from "./domain-wayfinding";

/** A navigable destination. `to` is typed against the generated route tree. */
export type NavItem = {
  to: LinkProps["to"];
  entity?: BrowserRoutedEntity;
  /** Static search params — only the scanner shortcut needs these today. */
  search?: Readonly<Record<string, string | undefined>>;
  label: string;
  icon: Icon;
};

/** A dropdown that nests leaves. Discriminated from {@link NavItem} by `children`. */
export type NavGroup = {
  label: string;
  icon: Icon;
  children: NavItem[];
  /** The stable Porcelain Transit line for the five household domains. */
  domain?: WayfindingDomain;
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
const inventory: NavItem = {
  to: "/inventory",
  entity: "inventory",
  label: "Inventory",
  icon: entities.inventory.phosphorIcon,
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
const activityDirectoryNavItem: NavItem = {
  to: "/activities",
  label: "Activities",
  icon: Activity,
};
const recordDirectoryNavItem: NavItem = {
  to: "/records",
  label: "Records",
  icon: Database,
};

export const desktopNav: NavNode[] = [
  activityDirectoryNavItem,
  ...activityViews.map((view): NavGroup => ({
    label: view.label,
    icon: view.icon,
    domain: view.key,
    tier: "primary",
    children: [...view.destinations],
  })),
  {
    ...recordDirectoryNavItem,
    tier: "primary",
    children: recordViews.filter(
      (view) =>
        !activityViews.some((activity) =>
          activity.destinations.some(
            (destination) =>
              "entity" in destination && destination.entity === view.entity,
          ),
        ),
    ),
  },
  {
    label: "More",
    icon: MoreHorizontal,
    tier: "utility",
    children: [
      scan,
      { to: "/labels", label: "Labels", icon: QrCode },
      { to: "/problems", label: "Problems", icon: AlertTriangle },
      { to: "/activity", label: "Activity", icon: Activity },
      { to: "/collections", label: "Collections", icon: Palette },
      { to: "/entities", label: "Entity explorer", icon: Network },
      { to: "/graph", label: "Graph", icon: Network },
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
      { to: "/mcp", label: "MCP tools", icon: Plug },
    ],
  },
];

/** Every rendered authed leaf, including contextual links under Activities. */
export const desktopLeaves: NavItem[] = desktopNav.flatMap((node) =>
  isNavGroup(node) ? node.children : [node],
);

/** Canonical signed-in destination universe, with contextual links deduped. */
export const completeNavLeaves: NavItem[] = [
  homeNavItem,
  ...desktopLeaves,
].filter(
  (item, index, all) =>
    all.findIndex((candidate) => candidate.to === item.to) === index,
);

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

/** Secondary phone destinations shown before the deeper taxonomy. */
export const mobileHouseholdItems: NavItem[] = [
  homeNavItem,
  activityDirectoryNavItem,
  recordDirectoryNavItem,
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
export function getEntityNavGroup(
  entity: BrowserRoutedEntity,
): NavGroup | undefined {
  const listRoute = entities[entity].routes.list;
  return desktopNav.find(
    (node): node is NavGroup =>
      isNavGroup(node) && node.children.some((child) => child.to === listRoute),
  );
}

/** Every reachable nav target, deduped — the universe active matching resolves over. */
const allTargets: string[] = uniq(
  [...completeNavLeaves, ...bottomNavItems, ...publicNavItems].map((leaf) =>
    String(leaf.to),
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
