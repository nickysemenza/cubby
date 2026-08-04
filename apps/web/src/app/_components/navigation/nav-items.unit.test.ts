import type { Entity } from "@cubby/schemas/entity";
import { describe, expect, it } from "vitest";
import { entities } from "~/entities/entities";
import { desktopNav, getEntityNavGroup, isNavGroup } from "./nav-items";

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
