import type { Entity } from "@cubby/schemas/entity";
import { allEntities } from "@cubby/schemas/entity-manifest";
import {
  WAYFINDING_DOMAINS,
  entitySummary,
  type WayfindingDomain,
  WAYFINDING_DOMAIN_PRESENTATION,
} from "@cubby/schemas/entity-summary";
import { SIDEBAR_SECTIONS } from "@cubby/schemas/sidebar-manifest";
import { mapRecord } from "@cubby/shared";

/** Shared identity hues also tint sidebar current rows. */
const DOMAIN_ICON_CLASSES = {
  cook: "text-(--brand-domain-cook)",
  pantry: "text-(--brand-domain-pantry)",
  plan: "text-(--brand-domain-plan)",
  garden: "text-(--brand-domain-garden)",
  house: "text-(--brand-domain-house)",
  purchases: "text-(--brand-domain-purchases)",
  finance: "text-(--brand-domain-finance)",
} satisfies Record<WayfindingDomain, string>;

/** Section-header chips in the sidebar and More sheet. */
const DOMAIN_CHIP_CLASSES = {
  cook: "bg-(--brand-domain-cook)",
  pantry: "bg-(--brand-domain-pantry)",
  plan: "bg-(--brand-domain-plan)",
  garden: "bg-(--brand-domain-garden)",
  house: "bg-(--brand-domain-house)",
  purchases: "bg-(--brand-domain-purchases)",
  finance: "bg-(--brand-domain-finance)",
} satisfies Record<WayfindingDomain, string>;

/** Current-route surfaces; unclassified sections keep the neutral accent. */
const DOMAIN_SURFACE_CLASSES = {
  cook: "bg-(--brand-domain-cook-surface) hover:bg-(--brand-domain-cook-surface)",
  pantry:
    "bg-(--brand-domain-pantry-surface) hover:bg-(--brand-domain-pantry-surface)",
  plan: "bg-(--brand-domain-plan-surface) hover:bg-(--brand-domain-plan-surface)",
  garden:
    "bg-(--brand-domain-garden-surface) hover:bg-(--brand-domain-garden-surface)",
  house:
    "bg-(--brand-domain-house-surface) hover:bg-(--brand-domain-house-surface)",
  purchases:
    "bg-(--brand-domain-purchases-surface) hover:bg-(--brand-domain-purchases-surface)",
  finance:
    "bg-(--brand-domain-finance-surface) hover:bg-(--brand-domain-finance-surface)",
} satisfies Record<WayfindingDomain, string>;

export function domainIconClass(
  domain: WayfindingDomain | null | undefined,
): string {
  return domain ? DOMAIN_ICON_CLASSES[domain] : "";
}

export function domainChipClass(domain: WayfindingDomain): string {
  return DOMAIN_CHIP_CLASSES[domain];
}

export function domainSurfaceClass(
  domain: WayfindingDomain | null | undefined,
): string {
  return domain
    ? DOMAIN_SURFACE_CLASSES[domain]
    : "bg-sidebar-accent hover:bg-sidebar-accent";
}

/** The stable wayfinding families used by the Field Guide shell. */
export type { WayfindingDomain };

/**
 * The entities whose records live on a line, from each declaration's
 * `presentation.domain`. Route roots come from the shared sidebar, including
 * workbench routes (`/calendar`) that belong to no entity.
 */
const entitiesOn = (domain: WayfindingDomain): readonly Entity[] =>
  allEntities.filter((entity) => entitySummary[entity].domain === domain);

export type DomainWayfinding = {
  id: WayfindingDomain;
  label: string;
  /** Entities whose canonical detail/list routes belong to this family. */
  entities: readonly Entity[];
  /** Route roots are kept here so shell and page identity share one taxonomy. */
  routeRoots: readonly string[];
};

const DOMAIN_WAYFINDING = mapRecord(
  WAYFINDING_DOMAINS,
  (domain): DomainWayfinding => ({
    id: domain,
    label: WAYFINDING_DOMAIN_PRESENTATION[domain].label,
    entities: entitiesOn(domain),
    routeRoots: SIDEBAR_SECTIONS.filter(
      (section) => section.domain === domain,
    ).flatMap((section) =>
      section.destinations.map((destination) => destination.route),
    ),
  }),
);

const domainEntries = Object.values(DOMAIN_WAYFINDING);

const routePath = (pathname: string): string => {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return withLeadingSlash.length > 1
    ? withLeadingSlash.replace(/\/+$/, "")
    : withLeadingSlash;
};

const matchesRouteRoot = (path: string, root: string) =>
  path === root || path.startsWith(`${root}/`);

/** Return null for utility, home, auth, and otherwise unclassified routes. */
export function domainForRoute(pathname: string): WayfindingDomain | null {
  const path = routePath(pathname);
  const match = domainEntries
    .flatMap((domain) =>
      domain.routeRoots.map((root) => ({ domain: domain.id, root })),
    )
    .filter(({ root }) => matchesRouteRoot(path, root))
    .sort((left, right) => right.root.length - left.root.length)[0];
  return match?.domain ?? null;
}

/** Product classification intentionally resolves to Pantry. */
export function domainForEntity(entity: Entity): WayfindingDomain | null {
  return entitySummary[entity].domain;
}

export function domainWayfinding(domain: WayfindingDomain): DomainWayfinding {
  return DOMAIN_WAYFINDING[domain];
}
