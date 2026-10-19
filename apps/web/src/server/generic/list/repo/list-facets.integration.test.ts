import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

// Registers the location scaffold with the facet registry.
import "~/server/domains/location/repo/crud";
import { listFacetCounter } from "~/server/generic/list/repo/list";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

/**
 * `listScaffold.countBy` (#2374 filter facets). Failure modes: a facet that
 * applies its own filter, so every other value counts zero and the
 * checklist can only narrow; a facet that drops the other filters, so its
 * counts disagree with the list; a reference facet keyed by internal id
 * instead of the shortcode the filter writes; a hierarchical reference
 * counted by direct assignment while its filter matches descendants.
 */
describe("list facet counts", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const create = (
      name: string,
      type: "room" | "shelf" | "drawer",
      parentId: NonNullable<
        Parameters<typeof makeLocationInput>[0]
      >["parentId"],
    ) =>
      createLocationFixture(
        ctx.db,
        makeLocationInput({ name, type, parentId }),
        ctx.actor,
      );
    const kitchen = await create("Facet kitchen", "room", null);
    const garage = await create("Facet garage", "room", null);
    await create("Facet spice shelf", "shelf", kitchen.id);
    await create("Facet can shelf", "shelf", kitchen.id);
    await create("Facet utensil drawer", "drawer", kitchen.id);
    await create("Facet tool shelf", "shelf", garage.id);
    return { kitchen, garage };
  };

  it("counts an enum facet under the other filters but not its own", async () => {
    const { kitchen } = await seed();
    const counter = listFacetCounter("location");
    const facet = await counter?.countBy(
      ctx.db,
      { itemTypeFilter: ["shelf"], parentId: [kitchen.id] },
      "type",
    );
    expect(facet).toEqual({
      id: "type",
      kind: "values",
      options: expect.arrayContaining([
        { value: "shelf", count: 2 },
        { value: "drawer", count: 1 },
      ]),
    });
    expect(facet?.kind === "values" ? facet.options : []).toHaveLength(2);
  });

  // Picking a location includes its descendants, so direct counts would show
  // a room whose rows sit on its shelves as 0; the facet is omitted instead.
  it("omits a hierarchical reference facet rather than count direct children", async () => {
    const { kitchen } = await seed();
    const facet = await listFacetCounter("location")?.countBy(
      ctx.db,
      { itemTypeFilter: ["shelf"], parentId: [kitchen.id] },
      "parent",
    );
    expect(facet).toBeNull();
  });
});
