import { readFileSync } from "node:fs";

import { browserRoutedEntities } from "@cubby/schemas/entity-manifest";
import { SIDEBAR_SECTIONS } from "@cubby/schemas/sidebar-manifest";
import { describe, expect, it } from "vitest";

import { entities } from "~/entity/entities";

import { domainForRoute } from "../../ui/navigation/domain-wayfinding";
import { findActiveTo, getEntityNavGroup, sidebarSections } from "./nav-items";

const manifestRoutes = SIDEBAR_SECTIONS.flatMap((section) =>
  section.destinations.map((destination) => destination.route),
);
const routeTree = readFileSync(
  new URL("../../routeTree.gen.ts", import.meta.url),
  "utf8",
);
const authenticatedRoutes = [
  ...new Set(
    [...routeTree.matchAll(/['"]\/_authenticated(\/[^'"]*)['"]: typeof/g)].map(
      (match) => (match[1] ?? "/").replace(/\/$/, "") || "/",
    ),
  ),
];
// These routes are contextual, global controls, account pages or retired redirects.
const contextualRoutes = new Set([
  "/connections",
  "/automatic-decisions",
  "/recommendations/workbench",
  "/search",
  "/settings",
  "/account/connected-apps",
  "/activities",
  "/records",
]);

describe("workspace navigation contract", () => {
  it("contains no duplicate routes", () => {
    expect(new Set(manifestRoutes).size).toBe(manifestRoutes.length);
  });
  it.each(browserRoutedEntities)(
    "gives %s exactly one canonical list destination",
    (entity) => {
      const entries = sidebarSections
        .flatMap((section) => section.children)
        .filter((item) => item.entity === entity);
      expect(entries.map((item) => item.to)).toEqual([
        entities[entity].routes.list,
      ]);
      expect(getEntityNavGroup(entity)?.children).toContain(entries[0]);
    },
  );
  it.each(
    authenticatedRoutes.filter(
      (route) =>
        !route.includes("$") &&
        !route.endsWith("/new") &&
        !contextualRoutes.has(route),
    ),
  )("gives static authenticated page %s a navigation home", (route) => {
    expect(manifestRoutes).toContain(route);
  });
  it.each(manifestRoutes.filter((route) => route !== "/"))(
    "uses an existing authenticated route for %s",
    (route) => {
      expect(authenticatedRoutes).toContain(route);
    },
  );
  it("keeps each section in its route-level domain", () => {
    for (const section of sidebarSections) {
      if (!section.domain) continue;
      for (const item of section.children)
        expect(domainForRoute(String(item.to))).toBe(section.domain);
    }
  });
  it.each([
    ["/", "/"],
    ["/expenses", "/expenses"],
    ["/expenses/EXP-42", "/expenses"],
    ["/ingredients/workbench", "/ingredients/workbench"],
    ["/ingredients/ING-42", "/ingredients"],
    ["/products-extra", undefined],
  ])("matches %s to its longest navigation target", (pathname, expected) => {
    expect(findActiveTo(pathname)).toBe(expected);
  });
});
