import { listViewId } from "@cubby/schemas/entity-definitions/definition";
import { browserRoutedEntities } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { describe, expect, it } from "vitest";

import { resolveListView } from "./resolve-list-view";

const listedEntities = browserRoutedEntities.filter(
  (entity) => entitySummary[entity].list.views.length > 0,
);

describe("resolveListView", () => {
  it.each(listedEntities)(
    "%s: `?view=` selects each declared view and defaults to the first",
    (entity) => {
      const { views } = entitySummary[entity].list;
      for (const declared of views) {
        expect(
          resolveListView(entity, { view: listViewId(declared) }).view,
        ).toEqual(
          entity === "run" && declared === "shelf" ? views[0] : declared,
        );
      }
      expect(resolveListView(entity, {}).view).toEqual(views[0]);
      expect(resolveListView(entity, { view: "no-such-view" }).view).toEqual(
        views[0],
      );
    },
  );

  it("keeps the old Projects gallery URL pointed at the shared Cards view", () => {
    expect(resolveListView("project", { view: "gallery" }).view).toBe("shelf");
  });
});
