import type { Entity } from "@cubby/schemas/entity";
import { describe, expect, it } from "vitest";
import { entities } from "~/entities/entities";
import {
  desktopLeaves,
  desktopNav,
  findActiveTo,
  getEntityNavGroup,
  getSidebarGroupItems,
  homeNavItem,
  isNavGroup,
  settingsNavItem,
} from "./nav-items";

describe("workspace navigation contract", () => {
  it("contains every desktop destination exactly once", () => {
    const targets = [homeNavItem, ...desktopLeaves].map((item) => item.to);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets.filter((target) => target === settingsNavItem.to)).toEqual([
      "/settings",
    ]);
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
  const entityKeys = Object.keys(entities) as Entity[];

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
      expect(matchingGroups).toHaveLength(1);
      expect(getEntityNavGroup(entity)).toBe(matchingGroups[0]);
    },
  );

  // Pins the actual group label per entity, so a future reorg that moves an
  // entity's list route to a different group is a visible, intentional test
  // change rather than a silent breadcrumb drift.
  it("derives the expected group label for every entity", () => {
    const expected: Record<Entity, string> = {
      recipe: "Cook",
      cookbook: "Cook",
      ingredient: "Cook",
      product: "Data",
      "usda-food": "Data",
      image: "Data",
      inventory: "Pantry",
      location: "Pantry",
      meal: "Plan",
      wish: "Plan",
      project: "House",
      task: "House",
      expense: "Finance",
      vendor: "Finance",
      purchase: "Finance",
      financialAccount: "Finance",
      financialTransaction: "Finance",
    };

    for (const entity of entityKeys) {
      expect(getEntityNavGroup(entity)?.label, entity).toBe(expected[entity]);
    }
  });
});

describe("railLabel", () => {
  it("never replaces the label the command palette searches", () => {
    // `command-menu` lists `leaf.label` and cmdk filters on that visible text,
    // so a leaf whose only text was the rail's short form would lose its search
    // terms — typing "background" would stop finding the jobs page. The rail
    // reads `railLabel`; every other surface keeps `label`.
    const shortened = desktopLeaves.filter((leaf) => leaf.railLabel);

    expect(shortened.length).toBeGreaterThan(0);
    for (const leaf of shortened) {
      expect(leaf.label, leaf.to as string).not.toBe(leaf.railLabel);
      expect(leaf.label.length, leaf.to as string).toBeGreaterThan(
        (leaf.railLabel as string).length,
      );
    }
  });

  it("keeps the full wording for the shortened leaves", () => {
    const byRoute = new Map(desktopLeaves.map((leaf) => [leaf.to, leaf.label]));

    expect(byRoute.get("/background-jobs")).toBe("Background jobs");
    expect(byRoute.get("/statement-rows")).toBe("Statement Rows");
    expect(byRoute.get("/meals/suggestions")).toBe("What can I make?");
  });
});
