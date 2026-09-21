import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { entities } from "~/entities/entities";

import { domainForRoute } from "./domain-wayfinding";
import {
  bottomNavItems,
  completeNavLeaves,
  desktopLeaves,
  desktopNav,
  developerNavGroups,
  findActiveTo,
  getEntityNavGroup,
  getSidebarGroupItems,
  isNavGroup,
  mobileHouseholdItems,
  primaryNavGroups,
  settingsNavItem,
  todayNavItems,
  utilityNavGroups,
} from "./nav-items";

describe("workspace navigation contract", () => {
  it("contains every desktop destination exactly once", () => {
    const targets = completeNavLeaves.map((item) => item.to);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets.filter((target) => target === settingsNavItem.to)).toEqual([
      "/settings",
    ]);
  });

  it("derives the intended navigation tiers from the canonical manifest", () => {
    expect(primaryNavGroups.map((group) => group.label)).toEqual([
      "Cook",
      "Pantry",
      "Plan",
      "House",
      "Finance",
      "Records",
    ]);
    expect(utilityNavGroups.map((group) => group.label)).toEqual(["More"]);
    expect(developerNavGroups.map((group) => group.label)).toEqual(["Dev"]);
    expect(primaryNavGroups.map((group) => group.domain)).toEqual([
      "cook",
      "pantry",
      "plan",
      "house",
      "finance",
      undefined,
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

  it("pins the task-first persistent and phone household choices", () => {
    expect(todayNavItems.map((item) => item.label)).toEqual([
      "Graph",
      "Recount inventory",
      "Build a shopping list",
      "Projects",
      "Problems",
    ]);
    expect(mobileHouseholdItems.map((item) => item.label)).toEqual([
      "Home",
      "Activities",
      "Records",
      "Recount inventory",
      "Locations",
      "Household calendar",
      "Meals",
      "Projects",
      "Expenses",
      "Problems",
    ]);
    expect(bottomNavItems.map((item) => item.label)).toEqual([
      "Today",
      "Inventory",
      "Scan",
      "Search",
    ]);
  });

  it("keeps utility and developer destinations available to Cmd-K", () => {
    const routes = new Set(completeNavLeaves.map((item) => item.to));
    expect(routes).toContain("/search/debug");
    expect(routes).toContain("/mcp");
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

  it("covers every entity defined in entities.tsx", () => {
    expect(entityKeys.length).toBeGreaterThan(0);
  });

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
      expect(matchingGroups.length).toBeGreaterThanOrEqual(1);
      expect(getEntityNavGroup(entity)).toBe(
        matchingGroups.find((group) => group.label === "Records"),
      );
    },
  );

  // Pins the actual group label per entity, so a future reorg that moves an
  // entity's list route to a different group is a visible, intentional test
  // change rather than a silent breadcrumb drift.
  it("derives the expected group label for every entity", () => {
    const expected = {
      recipe: "Records",
      cookbook: "Records",
      ingredient: "Records",
      product: "Records",
      productCategory: "Records",
      "usda-food": "Records",
      image: "Records",
      inventory: "Records",
      location: "Records",
      meal: "Records",
      wish: "Records",
      project: "Records",
      task: "Records",
      planting: "Records",
      gardenEntry: "Records",
      expense: "Records",
      vendor: "Records",
      vendorAccount: "Records",
      purchase: "Records",
      financialAccount: "Records",
      financialTransaction: "Records",
      ledgerParty: "Records",
      ledgerTransfer: "Records",
    } satisfies Record<BrowserRoutedEntity, string>;

    for (const entity of entityKeys) {
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(getEntityNavGroup(entity)?.label, entity).toBe(expected[entity]);
    }
  });
});

describe("expanded rail labels", () => {
  it("keeps full destination wording in the canonical manifest", () => {
    const byRoute = new Map(desktopLeaves.map((leaf) => [leaf.to, leaf.label]));

    expect(byRoute.get("/statement-rows")).toBe("Reconcile statements");
    expect(byRoute.get("/household-contribution")).toBe("Contribution ledger");
    expect(byRoute.get("/meals/suggestions")).toBe("What can I make?");
  });
});
