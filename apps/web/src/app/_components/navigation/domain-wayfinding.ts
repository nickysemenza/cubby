import type { Entity } from "@cubby/schemas/entity";

/** The stable wayfinding families used by the Porcelain Transit shell. */
export type WayfindingDomain = "cook" | "pantry" | "plan" | "house" | "finance";

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
    entities: ["recipe", "cookbook", "ingredient"],
    routeRoots: ["/recipes", "/cookbooks", "/ingredients"],
  },
  pantry: {
    id: "pantry",
    label: "Pantry",
    accentToken: "--domain-pantry",
    surfaceToken: "--domain-pantry-surface",
    // Products are intentionally Pantry/Inventory wayfinding, not a Product
    // status color. USDA data follows the Product catalog here as well.
    entities: ["product", "inventory", "location", "usda-food"],
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
    entities: ["meal", "wish"],
    routeRoots: ["/calendar", "/meals", "/wishes"],
  },
  house: {
    id: "house",
    label: "House",
    accentToken: "--domain-house",
    surfaceToken: "--domain-house-surface",
    entities: ["project", "task", "planting", "gardenEntry"],
    routeRoots: [
      "/projects",
      "/tools",
      "/tasks",
      "/garden",
      "/plantings",
      "/garden-entries",
    ],
  },
  finance: {
    id: "finance",
    label: "Finance",
    accentToken: "--domain-finance",
    surfaceToken: "--domain-finance-surface",
    entities: [
      "expense",
      "purchase",
      "vendor",
      "financialAccount",
      "financialTransaction",
      "ledgerParty",
      "ledgerTransfer",
    ],
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
  return (
    domainEntries.find((domain) =>
      domain.entities.some((candidate) => candidate === entity),
    )?.id ?? null
  );
}

export function domainWayfinding(domain: WayfindingDomain): DomainWayfinding {
  return DOMAIN_WAYFINDING[domain];
}
