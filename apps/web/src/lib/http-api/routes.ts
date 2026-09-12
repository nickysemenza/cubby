import {
  type AppRoute,
  type AppRouter,
  ContractNoBody,
  isAppRoute,
} from "@ts-rest/core";
import { z } from "zod";

import { httpMetadataSchema } from "./router";

/** Every route of a router, depth first. */
export function httpRoutes(router: AppRouter): AppRoute[] {
  return Object.values(router).flatMap((route) =>
    isAppRoute(route) ? [route] : httpRoutes(route),
  );
}

const routeMetadata = (route: AppRoute) =>
  z.object({ http: httpMetadataSchema }).parse({ http: route.metadata }).http;

/**
 * Reject routers whose routes would shadow one another or the documentation
 * endpoints: an RPC domain named like a resource collection, or a fixed path
 * that a `/:id` pattern would also match.
 */
export function checkHttpRoutes(router: AppRouter): void {
  const seen = new Set<string>();
  const routes = httpRoutes(router);
  for (const route of routes) {
    const key = `${route.method} ${route.path.replace(/:[^/]+/gu, ":id")}`;
    if (["/api/v1/docs", "/api/v1/openapi.json"].includes(route.path))
      throw new Error(`Reserved HTTP route collision: ${key}`);
    if (seen.has(key)) throw new Error(`HTTP route collision: ${key}`);
    seen.add(key);
    if (!route.path.includes(":")) {
      for (const candidate of routes) {
        if (
          !candidate.path.endsWith("/:id") ||
          !route.path.startsWith(candidate.path.slice(0, -3))
        )
          continue;
        const id = route.path.slice(candidate.path.length - 3);
        if (
          candidate.pathParams instanceof z.ZodType &&
          candidate.pathParams.safeParse({ id }).success
        )
          throw new Error(`HTTP resource identifier collision: ${route.path}`);
      }
    }
    routeMetadata(route);
    checkCarriers(route, key);
  }
}

/** A route carries its input as query parameters or as a body, never both. */
function checkCarriers(route: AppRoute, key: string): void {
  const hasQuery = route.query instanceof z.ZodType;
  const hasBody =
    "body" in route &&
    route.body !== ContractNoBody &&
    route.body instanceof z.ZodType;
  if (hasQuery && hasBody)
    throw new Error(`HTTP route carries both query and body: ${key}`);
  if (route.method === "GET" && hasBody)
    throw new Error(`HTTP GET route with a body: ${key}`);
  if (route.method !== "GET" && hasQuery)
    throw new Error(`HTTP ${route.method} route with query parameters: ${key}`);
}
