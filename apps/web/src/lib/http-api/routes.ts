import { isAppRoute, type AppRouter, type AppRoute } from "@ts-rest/core";
import { z } from "zod";

import { httpMetadataSchema, httpSchemaSources } from "./contract";

export function httpRoutes(router: AppRouter): AppRoute[] {
  return Object.values(router).flatMap((route) =>
    isAppRoute(route) ? [route] : httpRoutes(route),
  );
}
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
        if (httpPathSchema(candidate)?.safeParse({ id }).success)
          throw new Error(`HTTP resource identifier collision: ${route.path}`);
      }
    }
    z.object({ http: httpMetadataSchema }).parse(route.metadata);
  }
}
export function httpPathSchema(route: AppRoute) {
  return route.pathParams instanceof z.ZodType
    ? httpSchemaSources.get(route.pathParams)?.schema
    : undefined;
}
