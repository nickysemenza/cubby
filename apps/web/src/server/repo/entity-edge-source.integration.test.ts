import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createAndAssociateUploadedImage } from "~/server/repo/image";
import { mergeProducts } from "~/server/repo/product";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { findOrphanEntities, getEntityConnections } from "./entity-edge-source";

describe("entity edge source", () => {
  const ctx = withTestDb();

  const seedStockedProduct = async (name: string) => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: `${name} shelf` }),
      TEST_ACTOR,
    );
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name }),
      TEST_ACTOR,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
        placement: "stock",
      },
      TEST_ACTOR,
    );
    await createAndAssociateUploadedImage(
      ctx.db,
      {
        key: `test/${crypto.randomUUID()}.jpg`,
        filename: `${name}.jpg`,
        contentType: "image/jpeg",
        size: 10,
      },
      { entity: "product", id: item.entityId },
    );
    return { item, shelf };
  };

  it("groups one-hop connections both ways, across join rows and attachments", async () => {
    const { item, shelf } = await seedStockedProduct("Edge lamp");

    const connections = await getEntityConnections(ctx.db, { id: item.id });
    expect(connections).toMatchObject({ id: item.id, redirectedFrom: null });
    expect(connections.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "incoming",
          edgeKey: "InventoryEntry.productId",
          otherKind: "inventory",
          count: 1,
          disposition: null,
        }),
        // The attachment row's subject is the source; the image the target.
        expect.objectContaining({
          direction: "outgoing",
          edgeKey: "EntityAttachment.imageId",
          otherKind: "image",
          count: 1,
        }),
      ]),
    );

    const fromShelf = await getEntityConnections(ctx.db, { id: shelf.id });
    expect(fromShelf.groups).toContainEqual(
      expect.objectContaining({
        direction: "incoming",
        edgeKey: "InventoryEntry.locationId",
        count: 1,
      }),
    );
  });

  it("attaches the operation's declared disposition for an impact preview", async () => {
    const { item } = await seedStockedProduct("Edge chair");
    const preview = await getEntityConnections(ctx.db, {
      id: item.id,
      operation: "delete",
    });
    const stock = preview.groups.find(
      (group) => group.edgeKey === "InventoryEntry.productId",
    );
    expect(stock?.disposition).toMatchObject({ effect: expect.any(String) });
  });

  it("reads a merged-away code as its survivor", async () => {
    const { item } = await seedStockedProduct("Edge keeper");
    const loser = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Edge loser" }),
      TEST_ACTOR,
    );
    await mergeProducts(
      ctx.db,
      { keepId: item.id, mergeIds: [loser.id] },
      TEST_ACTOR,
    );
    expect(await getEntityConnections(ctx.db, { id: loser.id })).toMatchObject({
      id: item.id,
      redirectedFrom: loser.id,
    });
  });

  it("finds live entities of a checked kind with no connection", async () => {
    const { item } = await seedStockedProduct("Edge table");
    const lonely = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Edge orphan" }),
      TEST_ACTOR,
    );
    const orphans = await findOrphanEntities(ctx.db, { limit: 200 });
    const codes = orphans.items.map((entry) => entry.id);
    expect(codes).toContain(lonely.id);
    expect(codes).not.toContain(item.id);
    expect(orphans.count).toBeGreaterThanOrEqual(1);
  });
});
