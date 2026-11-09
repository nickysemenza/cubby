import { ROUTER_PATHS } from "~/lib/generated/router-paths.gen";

import { isBrowserOperationPath } from "./browser-operation-path";

export const UNMATCHED_TRACE_ROUTE = "/:unmatched";
export const SERVER_FUNCTION_TRACE_ROUTE = "/_serverFn/:functionId";

// This is an observability allowlist, not a router: only a declared path
// pattern can become a span name or attribute, and every parameter segment is
// replaced by its name. Router paths are generated; Worker paths outside the
// router are listed here in the same `$param` / trailing `$` splat syntax.
const WORKER_PATHS = [
  "/.well-known/caldav",
  "/api/caldav",
  "/api/doorbell",
  "/api/caldav/principals/$principal",
  "/api/caldav/calendars/$principal",
  "/api/caldav/calendars/$principal/$collection",
  "/api/caldav/calendars/$principal/$collection/$resource",
];

type DynamicRoute = { pattern: RegExp; template: string; rank: number[] };

const trimSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

const templateOf = (path: string): string =>
  path.replace(/\$([A-Za-z][A-Za-z0-9_]*)/gu, ":$1").replace(/\$$/u, ":splat");

const STATIC_TRACE_ROUTES = new Set<string>();
const dynamicRoutes: DynamicRoute[] = [];
for (const raw of [...ROUTER_PATHS, ...WORKER_PATHS]) {
  const path = trimSlash(raw);
  if (!path.includes("$")) {
    STATIC_TRACE_ROUTES.add(path);
    continue;
  }
  const segments = path.split("/").slice(1);
  const splat = segments.at(-1) === "$";
  const body = (splat ? segments.slice(0, -1) : segments)
    .map((segment) => (segment.startsWith("$") ? "/[^/]+" : `/${segment}`))
    .join("");
  dynamicRoutes.push({
    pattern: new RegExp(`^${body}${splat ? "(?:/.*)?" : ""}$`, "u"),
    template: templateOf(path),
    // Literal segments win over parameters, longer paths over shorter, and a
    // splat matches last.
    rank: [
      splat ? 1 : 0,
      -segments.filter((segment) => !segment.startsWith("$")).length,
      -segments.length,
    ],
  });
}
const DYNAMIC_TRACE_ROUTES = dynamicRoutes.toSorted((a, b) => {
  for (let index = 0; index < a.rank.length; index++) {
    const difference = a.rank[index]! - b.rank[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
});

const normalizePathname = (pathname: string): string =>
  pathname.startsWith("/") ? trimSlash(pathname) : UNMATCHED_TRACE_ROUTE;

/** Return a low-cardinality route template without exporting raw path values. */
export const httpRouteTemplate = (
  pathname: string,
  options?: { serverFunction?: boolean },
): string => {
  if (options?.serverFunction || pathname.startsWith("/_serverFn/")) {
    return SERVER_FUNCTION_TRACE_ROUTE;
  }

  const normalized = normalizePathname(pathname);
  if (isBrowserOperationPath(normalized)) return "/api/operations/:operations";
  if (STATIC_TRACE_ROUTES.has(normalized)) return normalized;
  return (
    DYNAMIC_TRACE_ROUTES.find((route) => route.pattern.test(normalized))
      ?.template ?? UNMATCHED_TRACE_ROUTE
  );
};
