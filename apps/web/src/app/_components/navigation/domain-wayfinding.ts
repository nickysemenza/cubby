import type { Entity } from "@cubby/schemas/entity";
import { allEntities } from "@cubby/schemas/entity-manifest";
import {
  entitySummary,
  type WayfindingDomain,
} from "@cubby/schemas/entity-summary";

/** The stable wayfinding families used by the Porcelain Transit shell. */
export type { WayfindingDomain };

/**
 * The entities whose records live on a line, from each declaration's
 * `presentation.domain`. Route roots below stay hand-listed: they include
 * workbench routes (`/scan`, `/calendar`) that belong to no entity.
 */
const entitiesOn = (domain: WayfindingDomain): readonly Entity[] =>
  allEntities.filter((entity) => entitySummary[entity].domain === domain);

export type DomainWayfinding = {
  id: WayfindingDomain;
  label: string;
  /** CSS custom-property tokens; components own the actual theme values. */
  accentToken: `--domain-${WayfindingDomain}`;
  surfaceToken: `--domain-${WayfindingDomain}-surface`;
  /** Entities whose canonical detail/list routes belong to this family. */
  entities: readonly Entity[];
  /** Route roots are kept here so shell and page identity share one taxonomy. */
  routeRoots: readonly string[];
};

export const DOMAIN_WAYFINDING = {
  cook: {
    id: "cook",
    label: "Cook",
    accentToken: "--domain-cook",
    surfaceToken: "--domain-cook-surface",
    entities: entitiesOn("cook"),
    routeRoots: ["/recipes", "/cookbooks", "/ingredients"],
  },
  pantry: {
    id: "pantry",
    label: "Pantry",
    accentToken: "--domain-pantry",
    surfaceToken: "--domain-pantry-surface",
    entities: entitiesOn("pantry"),
    routeRoots: [
      "/products",
      "/inventory",
      "/locations",
      "/scan",
      "/labels",
      "/collections",
      "/pantry-view",
    ],
  },
  plan: {
    id: "plan",
    label: "Plan",
    accentToken: "--domain-plan",
    surfaceToken: "--domain-plan-surface",
    entities: entitiesOn("plan"),
    routeRoots: ["/calendar", "/meals", "/wishes"],
  },
  house: {
    id: "house",
    label: "House",
    accentToken: "--domain-house",
    surfaceToken: "--domain-house-surface",
    entities: entitiesOn("house"),
    routeRoots: [
      "/projects",
      "/tools",
      "/tasks",
      "/plantings",
      "/garden-workbench",
      "/garden-entries",
    ],
  },
  finance: {
    id: "finance",
    label: "Finance",
    accentToken: "--domain-finance",
    surfaceToken: "--domain-finance-surface",
    entities: entitiesOn("finance"),
    routeRoots: [
      "/expenses",
      "/purchases",
      "/vendors",
      "/financial-accounts",
      "/financial-transactions",
      "/household-contribution",
      "/statement-rows",
      "/ledger-parties",
      "/ledger-transfers",
    ],
  },
} as const satisfies Record<WayfindingDomain, DomainWayfinding>;

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
