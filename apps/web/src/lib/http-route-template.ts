export const UNMATCHED_TRACE_ROUTE = "/:unmatched";
export const SERVER_FUNCTION_TRACE_ROUTE = "/_serverFn/:functionId";

// This is an observability allowlist, not a router. Static paths must be named
// explicitly so an identifier introduced by a future route can never become a
// span name or attribute by default. The generated-route guard in the sibling
// unit test makes catalog drift fail closed and visible in CI.
const STATIC_TRACE_ROUTES = new Set([
  "/",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/openid-configuration",
  "/account/connected-apps",
  "/activity",
  "/ai-smoke-test",
  "/ai-usage",
  "/api/agent-stream/ask",
  "/api/ai-stream/backfill-location-descriptions",
  "/api/ai-stream/precompute-enrichment-proposals",
  "/api/debug/timing",
  "/api/mcp",
  "/api/problems-stream/prune-unused-aliases",
  "/api/problems-stream/reparse-stale",
  "/api/product-stream/backfill-upc-images",
  "/api/product-stream/create-many",
  "/api/product-stream/mark-usda-unavailable",
  "/api/recipe-stream/import-cookbook",
  "/api/recipe-stream/import-notion",
  "/api/recipe-stream/recompute-all",
  "/api/recipe-stream/recompute-stale",
  "/api/recipe-stream/reprocess-cookbook",
  "/ask",
  "/background-jobs",
  "/calendar",
  "/collections",
  "/collections/assignments",
  "/cookbooks",
  "/design",
  "/docs",
  "/entities",
  "/expenses",
  "/financial-accounts",
  "/financial-transactions",
  "/household-contribution",
  "/images",
  "/ingredients",
  "/ingredients/equivalences",
  "/ingredients/new",
  "/ingredients/workbench",
  "/inventory",
  "/inventory/bulk-edit",
  "/inventory/bulk-move",
  "/inventory/new",
  "/inventory/session",
  "/labels",
  "/locations",
  "/locations/arrange",
  "/locations/new",
  "/locations/photo-pass",
  "/mcp",
  "/meals",
  "/meals/shopping-list",
  "/meals/suggestions",
  "/oauth/consent",
  "/pantry-view",
  "/problems",
  "/products",
  "/products/new",
  "/projects",
  "/projects/tools",
  "/purchases",
  "/recipes",
  "/recipes/compare",
  "/recipes/import",
  "/recipes/new",
  "/recommendations/workbench",
  "/scan",
  "/search",
  "/search/debug",
  "/settings",
  "/statement-rows",
  "/tasks",
  "/usda",
  "/vendors",
  "/wishes",
]);

const DETAIL_COLLECTIONS = [
  "cookbooks",
  "expenses",
  "financial-accounts",
  "financial-transactions",
  "images",
  "ingredients",
  "inventory",
  "locations",
  "meals",
  "products",
  "projects",
  "purchases",
  "recipes",
  "tasks",
  "vendors",
  "wishes",
].join("|");

const DYNAMIC_TRACE_ROUTES: ReadonlyArray<{
  pattern: RegExp;
  template: string;
}> = [
  {
    pattern: /^\/api\/calendar\/[^/]+\/[^/]+$/u,
    template: "/api/calendar/:token/:feed",
  },
  { pattern: /^\/api\/auth(?:\/.*)?$/u, template: "/api/auth/:splat" },
  {
    pattern: /^\/recipes\/[^/]+\/export$/u,
    template: "/recipes/:shortcode/export",
  },
  { pattern: /^\/usda\/ndb\/[^/]+$/u, template: "/usda/ndb/:code" },
  { pattern: /^\/usda\/upc\/[^/]+$/u, template: "/usda/upc/:code" },
  { pattern: /^\/usda\/[^/]+$/u, template: "/usda/:id" },
  { pattern: /^\/auth\/[^/]+$/u, template: "/auth/:authView" },
  { pattern: /^\/account\/[^/]+$/u, template: "/account/:accountView" },
  { pattern: /^\/docs\/[^/]+$/u, template: "/docs/:section" },
  {
    pattern: /^\/collections\/[^/]+$/u,
    template: "/collections/:collection",
  },
  {
    pattern: new RegExp(`^/(${DETAIL_COLLECTIONS})/[^/]+$`, "u"),
    template: "/$1/:shortcode",
  },
  { pattern: /^\/[^/]+$/u, template: "/:shortcode" },
];

const normalizePathname = (pathname: string): string => {
  if (!pathname.startsWith("/")) return UNMATCHED_TRACE_ROUTE;
  if (pathname.length > 1 && pathname.endsWith("/"))
    return pathname.slice(0, -1);
  return pathname;
};

/** Return a low-cardinality route template without exporting raw path values. */
export const httpRouteTemplate = (
  pathname: string,
  options?: { serverFunction?: boolean },
): string => {
  if (options?.serverFunction || pathname.startsWith("/_serverFn/")) {
    return SERVER_FUNCTION_TRACE_ROUTE;
  }

  const normalized = normalizePathname(pathname);
  if (STATIC_TRACE_ROUTES.has(normalized)) return normalized;

  for (const route of DYNAMIC_TRACE_ROUTES) {
    const match = route.pattern.exec(normalized);
    if (!match) continue;
    return match[1] ? route.template.replace("$1", match[1]) : route.template;
  }

  return UNMATCHED_TRACE_ROUTE;
};
