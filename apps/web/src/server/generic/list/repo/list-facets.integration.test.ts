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
 * instead of the shortcode the filter writes.
 */
describe("list facet counts", () => {
  const ctx = withTestDb();

  const seed = async () => {
    const create = (
      name: string,
      type: "room" | "shelf" | "drawer",
      parentId: string | null,
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

  it("counts a reference facet by shortcode under the other filters but not its own", async () => {
    const { kitchen, garage } = await seed();
    const facet = await listFacetCounter("location")?.countBy(
      ctx.db,
      { itemTypeFilter: ["shelf"], parentId: [kitchen.id] },
      "parent",
    );
    const options = facet?.kind === "values" ? facet.options : [];
    expect(options).toEqual(
      expect.arrayContaining([
        { value: kitchen.id, count: 2 },
        { value: garage.id, count: 1 },
      ]),
    );
  });
});
