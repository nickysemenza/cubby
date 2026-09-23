import { browserRoutedEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { entities } from "~/entities/entities";

import { activityViews, recordViewFor, recordViews } from "./application-views";

const activityRoutes = activityViews.flatMap((view) =>
  view.destinations.map((destination) => String(destination.to)),
);

describe("application view manifest", () => {
  it("keeps the five Porcelain Transit activity families in shell order", () => {
    expect(activityViews.map((view) => view.key)).toEqual([
      "cook",
      "pantry",
      "plan",
      "house",
      "finance",
    ]);
  });

  it("keeps specialist activity routes reachable from the activity catalog", () => {
    expect(new Set(activityRoutes)).toEqual(
      new Set([
        "/ingredients/workbench",
        "/ingredients/equivalences",
        "/recipes/compare",
        "/recipes/import",
        "/recipes",
        "/cookbooks",
        "/inventory/session",
        "/inventory",
        "/locations",
        "/scan",
        "/inventory/bulk-move",
        "/locations/photo-pass",
        "/locations/arrange",
        "/pantry-view",
        "/labels",
        "/calendar",
        "/meals",
        "/wishes",
        "/meals/suggestions",
        "/meals/shopping-list",
        "/tools",
        "/projects",
        "/tasks",
        "/plantings",
        "/garden-workbench",
        "/projects/tools",
        "/household-contribution",
        "/statement-rows",
        "/expenses",
        "/purchases",
      ]),
    );
  });

  it("covers every browser-routed entity exactly once in Records", () => {
    const entitiesWithRoutes = Object.keys(entities);
    const recordEntities = recordViews.map((view) => view.entity);

    expect(recordEntities).toHaveLength(entitiesWithRoutes.length);
    expect(new Set(recordEntities).size).toBe(recordEntities.length);
    expect(new Set(recordEntities)).toEqual(new Set(entitiesWithRoutes));
  });

  it("derives each Records destination from its entity route declaration", () => {
    for (const entity of browserRoutedEntities) {
      const view = recordViewFor(entity);
      expect(view.to).toBe(entities[entity].routes.list);
      expect(view.label).toBe(entities[entity].pluralLabel);
    }
  });
});
