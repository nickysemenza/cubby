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
 * Reject routers with two routes on one method and path, or a route whose
 * metadata or input carrier is malformed.
 */
export function checkHttpRoutes(router: AppRouter): void {
  const seen = new Set<string>();
  for (const route of httpRoutes(router)) {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) throw new Error(`HTTP route collision: ${key}`);
    seen.add(key);
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
