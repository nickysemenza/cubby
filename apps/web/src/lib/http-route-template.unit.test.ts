import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  httpRouteTemplate,
  SERVER_FUNCTION_TRACE_ROUTE,
  UNMATCHED_TRACE_ROUTE,
} from "./http-route-template";

const normalizeRoutePattern = (routePattern: string): string => {
  const withoutTrailingSlash =
    routePattern.length > 1 && routePattern.endsWith("/")
      ? routePattern.slice(0, -1)
      : routePattern;
  return withoutTrailingSlash
    .replace(/\$([A-Za-z][A-Za-z0-9_]*)/gu, ":$1")
    .replace(/\$$/u, ":splat");
};

const makeConcretePath = (routePattern: string): string =>
  routePattern
    .replace(/\$([A-Za-z][A-Za-z0-9_]*)/gu, "private-$1")
    .replace(/\$$/u, "private-splat/tail");

describe("httpRouteTemplate", () => {
  it("covers every generated route with its static or parameterized template", () => {
    const generatedTree = readFileSync(
      new URL("../routeTree.gen.ts", import.meta.url),
      "utf8",
    );
    const routePatterns = [
      ...generatedTree.matchAll(/fullPath: '([^']+)'/gu),
    ].map((match) => match[1]);

    expect(routePatterns.length).toBeGreaterThan(0);
    for (const routePattern of new Set(routePatterns)) {
      if (!routePattern) continue;
      expect(
        httpRouteTemplate(makeConcretePath(routePattern)),
        routePattern,
      ).toBe(normalizeRoutePattern(routePattern));
    }
  });

  it("redacts server-function ids and unknown paths", () => {
    expect(httpRouteTemplate("/_serverFn/private-function-id")).toBe(
      SERVER_FUNCTION_TRACE_ROUTE,
    );
    expect(httpRouteTemplate("/future/private-id/another-secret")).toBe(
      UNMATCHED_TRACE_ROUTE,
    );
  });

  it("never exports calendar credentials", () => {
    expect(httpRouteTemplate("/api/calendar/secret-token/private-feed")).toBe(
      "/api/calendar/:token/:feed",
    );
  });
});
