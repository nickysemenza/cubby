import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { entities } from "~/entities/entities";

import { domainForRoute } from "./domain-wayfinding";
import {
  completeNavLeaves,
  desktopNav,
  findActiveTo,
  getEntityNavGroup,
  getSidebarGroupItems,
  isNavGroup,
  primaryNavGroups,
  settingsNavItem,
} from "./nav-items";

describe("workspace navigation contract", () => {
  it("contains every desktop destination exactly once", () => {
    const targets = completeNavLeaves.map((item) => item.to);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets.filter((target) => target === settingsNavItem.to)).toEqual([
      "/settings",
    ]);
  });

  it("keeps every primary destination in its route-level domain", () => {
    for (const group of primaryNavGroups) {
      if (group.domain === undefined) continue;
      for (const item of group.children) {
        // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
        expect(domainForRoute(String(item.to)), item.label).toBe(group.domain);
      }
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

  it("keeps Settings in the manifest while reserving it for the sidebar footer", () => {
    const more = desktopNav.find(
      (node) => isNavGroup(node) && node.label === "More",
    );
    expect(more && isNavGroup(more)).toBe(true);
    if (!more || !isNavGroup(more)) return;

    expect(more.children).toContain(settingsNavItem);
    expect(more.children.map((item) => item.label)).toEqual(
      expect.arrayContaining(["Scan", "Labels", "Problems"]),
    );
    expect(getSidebarGroupItems(more)).not.toContain(settingsNavItem);
  });
});

// This is the regression test for the drift `getEntityNavGroup` replaced: a
// hand-kept `Partial<Record<Entity, string>>` map in page-hero.tsx that fell
// out of sync with `desktopNav` (the Cook/Data reorg moved products,
// ingredients, usda-food, and image without the map following, and never
// covered vendor/purchase/wish at all). Deriving from `desktopNav` instead
// means an entity list route can't silently point nowhere or somewhere wrong.
describe("getEntityNavGroup", () => {
  const entityKeys = Object.keys(entities).filter(
    (entity): entity is BrowserRoutedEntity => entity in entities,
  );

  it.each(entityKeys)(
    "resolves entity %s to exactly one nav group",
    (entity) => {
      const listRoute = entities[entity].routes.list;
      // Recomputed independently of getEntityNavGroup's implementation, so
      // this also catches a route appearing in zero or multiple groups —
      // the case getEntityNavGroup deliberately has no fallback for.
      const matchingGroups = desktopNav.filter(
        (node) =>
          isNavGroup(node) &&
          node.children.some((child) => child.to === listRoute),
      );
      expect(matchingGroups).toHaveLength(1);
      expect(getEntityNavGroup(entity)).toBe(matchingGroups[0]);
    },
  );
});
