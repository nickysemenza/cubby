import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import type { WayfindingDomain } from "@cubby/schemas/entity-summary";
import { SIDEBAR_SECTIONS } from "@cubby/schemas/sidebar-manifest";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { BookOpenTextIcon } from "@phosphor-icons/react/dist/csr/BookOpenText";
import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { ChartLineIcon } from "@phosphor-icons/react/dist/csr/ChartLine";
import { ChefHatIcon } from "@phosphor-icons/react/dist/csr/ChefHat";
import { CreditCardIcon } from "@phosphor-icons/react/dist/csr/CreditCard";
import { CubeFocusIcon } from "@phosphor-icons/react/dist/csr/CubeFocus";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { LayoutIcon } from "@phosphor-icons/react/dist/csr/Layout";
import { LightbulbIcon } from "@phosphor-icons/react/dist/csr/Lightbulb";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { NetworkIcon } from "@phosphor-icons/react/dist/csr/Network";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PlantIcon } from "@phosphor-icons/react/dist/csr/Plant";
import { PlugIcon } from "@phosphor-icons/react/dist/csr/Plug";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { QrCodeIcon } from "@phosphor-icons/react/dist/csr/QrCode";
import { ShoppingBagIcon } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { ShoppingCartIcon } from "@phosphor-icons/react/dist/csr/ShoppingCart";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { WarehouseIcon } from "@phosphor-icons/react/dist/csr/Warehouse";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import type { Icon } from "@phosphor-icons/react/lib";
import { type LinkProps, useLocation } from "@tanstack/react-router";
import { uniq } from "es-toolkit";

import { entities } from "~/entity/entities";

import {
  domainForEntity,
  domainForRoute,
  domainIconClass,
  domainSurfaceClass,
} from "../../ui/navigation/domain-wayfinding";

export type NavItem = {
  to: LinkProps["to"];
  entity?: BrowserRoutedEntity;
  label: string;
  icon: Icon;
  domain?: WayfindingDomain | null;
};
export type NavGroup = {
  id: string;
  label: string;
  icon: Icon;
  children: NavItem[];
  domain: WayfindingDomain | null;
  defaultFolded: boolean;
  to?: LinkProps["to"];
};

const routeIcons = {
  "/": HouseIcon,
  "/activity": PulseIcon,
  "/work-queue": ListChecksIcon,
  "/calendar": CalendarBlankIcon,
  "/meals/suggestions": SparkleIcon,
  "/meals/shopping-list": ShoppingCartIcon,
  "/ingredients/workbench": ListChecksIcon,
  "/ingredients/equivalences": ArrowsLeftRightIcon,
  "/recipes/compare": LayoutIcon,
  "/recipes/import": BookOpenTextIcon,
  "/pantry-view": CubeFocusIcon,
  "/inventory/triage": ListChecksIcon,
  "/locations/arrange": WarehouseIcon,
  "/labels": QrCodeIcon,
  "/garden-workbench": PlantIcon,
  "/tools": WrenchIcon,
  "/cash-flow": ChartLineIcon,
  "/household-contribution": ArrowsLeftRightIcon,
  "/runs/types": ListChecksIcon,
  "/suggestions": LightbulbIcon,
  "/entities": NetworkIcon,
  "/graph": NetworkIcon,
  "/design": PaletteIcon,
  "/ai": SparkleIcon,
  "/search/debug": MagnifyingGlassIcon,
  "/mcp": PlugIcon,
};
const sectionIcons = {
  top: HouseIcon,
  plan: CalendarBlankIcon,
  cook: ChefHatIcon,
  pantry: WarehouseIcon,
  garden: PlantIcon,
  house: WrenchIcon,
  purchases: ShoppingBagIcon,
  finance: CreditCardIcon,
  records: DatabaseIcon,
  dev: WrenchIcon,
};

/** Web adds glyph components; ordering, labels, membership and defaults stay shared. */
export const sidebarSections: NavGroup[] = SIDEBAR_SECTIONS.map((section) => ({
  id: section.id,
  label: section.label,
  domain: section.domain,
  defaultFolded: section.defaultFolded,
  icon: sectionIcons[section.id],
  children: section.destinations.map((destination): NavItem => ({
    to: destination.route,
    label: destination.label,
    domain: section.domain,
    ...("entity" in destination
      ? {
          entity: destination.entity,
          icon: entities[destination.entity].phosphorIcon,
        }
      : { icon: routeIcons[destination.route] }),
  })),
}));
export const navGroups = sidebarSections.filter(
  (section) => section.id !== "top",
);
export const topNavItems = sidebarSections
  .filter((section) => section.id === "top")
  .flatMap((section) => section.children);
const homeNavItem: NavItem = { to: "/", label: "Home", icon: HouseIcon };
export const settingsNavItem: NavItem = {
  to: "/settings",
  label: "Settings",
  icon: GearIcon,
};
export const completeNavLeaves = [
  ...sidebarSections.flatMap((section) => section.children),
  settingsNavItem,
];
export function navIconClass(node: NavItem | NavGroup): string {
  const domain =
    node.domain !== undefined
      ? node.domain
      : "children" in node
        ? null
        : node.entity
          ? domainForEntity(node.entity)
          : domainForRoute(node.to ?? "/");
  return domainIconClass(domain) || "text-muted-foreground";
}
/** Current rows use the section hue, including entity destinations filed outside their identity domain. */
export function navActiveClass(node: NavItem | NavGroup): string {
  return domainSurfaceClass(node.domain);
}
export function navItemLinkProps(item: NavItem, active: boolean) {
  return {
    to: item.to,
    preload: "intent" as const,
    preloadDelay: 40,
    "aria-current": active ? ("page" as const) : undefined,
  };
}
export const bottomNavItems: NavItem[] = [
  { to: "/", label: "Today", icon: HouseIcon },
  {
    to: "/inventory",
    entity: "inventory",
    label: "Inventory",
    icon: entities.inventory.phosphorIcon,
  },
  { to: "/search", label: "Search", icon: MagnifyingGlassIcon },
];
export const publicNavItems: NavItem[] = [
  homeNavItem,
  { to: "/docs", label: "Docs", icon: FileTextIcon },
];
export function getEntityNavGroup(
  entity: BrowserRoutedEntity,
): NavGroup | undefined {
  return sidebarSections.find((section) =>
    section.children.some((item) => item.entity === entity),
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
  return useLocation({ select: (location) => findActiveTo(location.pathname) });
}
