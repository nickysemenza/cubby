import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { BarcodeIcon } from "@phosphor-icons/react/dist/csr/Barcode";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { NetworkIcon } from "@phosphor-icons/react/dist/csr/Network";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { QrCodeIcon } from "@phosphor-icons/react/dist/csr/QrCode";
import { RobotIcon } from "@phosphor-icons/react/dist/csr/Robot";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
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
export const homeNavItem: NavItem = { to: "/", label: "Home", icon: HouseIcon };
const inventory: NavItem = {
  to: "/inventory",
  entity: "inventory",
  label: "Inventory",
  icon: entities.inventory.phosphorIcon,
};
const scan: NavItem = {
  to: "/scan",
  label: "Scan",
  icon: BarcodeIcon,
};
export const settingsNavItem: NavItem = {
  to: "/settings",
  label: "Settings",
  icon: GearIcon,
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
  icon: PulseIcon,
};
const recordDirectoryNavItem: NavItem = {
  to: "/records",
  label: "Records",
  icon: DatabaseIcon,
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
    icon: DotsThreeIcon,
    tier: "utility",
    children: [
      scan,
      { to: "/labels", label: "Labels", icon: QrCodeIcon },
      { to: "/problems", label: "Problems", icon: WarningIcon },
      { to: "/activity", label: "Activity", icon: PulseIcon },
      { to: "/collections", label: "Collections", icon: PaletteIcon },
      { to: "/entities", label: "Entity explorer", icon: NetworkIcon },
      { to: "/graph", label: "Graph", icon: NetworkIcon },
      { to: "/search", label: "Search", icon: MagnifyingGlassIcon },
      settingsNavItem,
    ],
  },
  {
    label: "Dev",
    icon: WrenchIcon,
    tier: "developer",
    children: [
      { to: "/design", label: "Design", icon: PaletteIcon },
      { to: "/ai-smoke-test", label: "AI smoke test", icon: SparkleIcon },
      { to: "/ai-usage", label: "AI usage", icon: RobotIcon },
      { to: "/search/debug", label: "Search debug", icon: MagnifyingGlassIcon },
      { to: "/mcp", label: "MCP tools", icon: PlugIcon },
    ],
  },
];

/** Every rendered authed leaf, including contextual links under Activities. */
const desktopLeaves: NavItem[] = desktopNav.flatMap((node) =>
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
const utilityNavGroups = desktopNav.filter(
  (node): node is NavGroup => isNavGroup(node) && node.tier === "utility",
);
const developerNavGroups = desktopNav.filter(
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
  { to: "/", label: "Today", icon: HouseIcon },
  inventory,
  scan,
  { to: "/search", label: "Search", icon: MagnifyingGlassIcon },
];

/** A labeled group of leaves in the mobile "More" sheet. */
export type NavSection = { title: string; items: NavItem[] };

/** Signed-out bar / bottom tabs — always flat leaves (no dropdowns). */
export const publicNavItems: NavItem[] = [
  homeNavItem,
  { to: "/docs", label: "Docs", icon: FileTextIcon },
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
