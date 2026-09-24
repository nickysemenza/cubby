import { browserRoutedEntities } from "@cubby/schemas/entity-manifest";
import { describe, expect, it } from "vitest";

import { entities } from "~/entities/entities";

import { recordViewFor, recordViews } from "./application-views";

describe("application view manifest", () => {
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
