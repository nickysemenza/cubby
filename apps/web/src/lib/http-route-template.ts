import { generatedBrowserRoutes } from "~/entities/generated/entity-routes.gen";

export const UNMATCHED_TRACE_ROUTE = "/:unmatched";
export const SERVER_FUNCTION_TRACE_ROUTE = "/_serverFn/:functionId";

// This is an observability allowlist, not a router. Non-entity static paths
// are named explicitly so an identifier introduced by a future route can never
// become a span name or attribute by default; entity list and detail routes
// come from the generated entity routes so a new entity's `/things` and
// `/things/:shortcode` templates exist without a line here. Either way the
// generated-route guard in the sibling unit test makes catalog drift fail
// closed and visible in CI.
const ENTITY_ROUTES = Object.values(generatedBrowserRoutes);

const STATIC_TRACE_ROUTES = new Set([
  ...ENTITY_ROUTES.map(({ routes }) => routes.list),
  "/",
  "/.well-known/apple-app-site-association",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/api/auth",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/openid-configuration",
  "/account/connected-apps",
  "/activities",
  "/activity",
  "/ai-smoke-test",
  "/ai-usage",
  "/api/debug/timing",
  "/api/import/agent/accounts",
  "/api/import/agent/debug-events",
  "/api/import/agent/oauth/callback",
  "/api/import/agent/oauth/start",
  "/api/import/agent/oauth/status",
  "/api/import/agent/socket",
  "/api/companion/image-processing/socket",
  "/api/import/agent/sync",
  "/api/import/merchant-rules",
  "/api/import/run-logs",
  "/api/import/runs",
  "/api/import/targeted",
  "/api/mcp",
  "/api/settings/member-logins",
  "/api/v1/docs",
  "/api/v1/openapi.json",
  "/auth/native",
  "/background-jobs",
  "/calendar",
  "/collections",
  "/collections/assignments",
  "/design",
  "/docs",
  "/entities",
  "/graph",
  "/household-contribution",
  "/ingredients/equivalences",
  "/ingredients/workbench",
  "/inventory/bulk-edit",
  "/inventory/bulk-move",
  "/inventory/session",
  "/labels",
  "/locations/arrange",
  "/locations/photo-pass",
  "/mcp",
  "/meals/shopping-list",
  "/meals/suggestions",
  "/oauth/consent",
  "/pantry-view",
  "/problems",
  "/projects/tools",
  "/recipes/compare",
  "/recipes/import",
  "/recipes/new",
  "/recommendations/workbench",
  "/records",
  "/scan",
  "/search",
  "/search/debug",
  "/settings",
  "/statement-rows",
  "/tools",
]);

// Every entity whose detail route is keyed by shortcode; `usda-food` (`/usda/:id`)
// keeps its own dynamic entries below.
const DETAIL_COLLECTIONS = ENTITY_ROUTES.filter(({ routes }) =>
  routes.detail.endsWith("/$shortcode"),
)
  .map(({ basePath }) => basePath)
  .join("|");

const DYNAMIC_TRACE_ROUTES: ReadonlyArray<{
  pattern: RegExp;
  template: string;
}> = [
  {
    pattern: /^\/purchase-imports\/[^/]+$/u,
    template: "/purchase-imports/:shortcode",
  },
  {
    pattern: /^\/api\/import\/runs\/[^/]+$/u,
    template: "/api/import/runs/:publicId",
  },
  {
    pattern: /^\/api\/import\/runs\/[^/]+\/agent$/u,
    template: "/api/import/runs/:publicId/agent",
  },
  {
    pattern: /^\/api\/import\/runs\/[^/]+\/agent\/.*$/u,
    template: "/api/import/runs/:publicId/agent/:splat",
  },
  {
    pattern: /^\/api\/calendar\/[^/]+\/[^/]+$/u,
    template: "/api/calendar/:token/:feed",
  },
  { pattern: /^\/api\/v1\/[^/]+$/u, template: "/api/v1/:resource" },
  {
    pattern: /^\/api\/v1\/[^/]+\/[^/]+$/u,
    template: "/api/v1/:resource/:operation",
  },
  { pattern: /^\/api\/auth(?:\/.*)?$/u, template: "/api/auth/:splat" },
  // One route for every workflow stream since the 13 bespoke stream routes
  // were replaced; the operation id is a registry key, but it stays out of
  // the span name like every other path segment.
  {
    pattern: /^\/api\/workflow-stream\/[^/]+$/u,
    template: "/api/workflow-stream/:operation",
  },
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
    pattern: /^\/collections\/smart\/[^/]+$/u,
    template: "/collections/smart/:starter",
  },
  {
    pattern: /^\/collections\/wardrobe\/[^/]+$/u,
    template: "/collections/wardrobe/:owner",
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
