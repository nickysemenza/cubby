import { describe, expect, it } from "vitest";

import { entities } from "~/entity/entities";

import { recordViews } from "./application-views";

describe("application view manifest", () => {
  it("covers every browser-routed entity exactly once in Records", () => {
    const entitiesWithRoutes = Object.keys(entities);
    const recordEntities = recordViews.map((view) => view.entity);

    expect(recordEntities).toHaveLength(entitiesWithRoutes.length);
    expect(new Set(recordEntities).size).toBe(recordEntities.length);
    expect(new Set(recordEntities)).toEqual(new Set(entitiesWithRoutes));
  });
});
