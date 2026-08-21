import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getCollectionDetail, getCollectionMatrix } from "./collection";
import { updateProduct } from "./product";
import {
  createImageFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "./repo.fixtures";

describe("Collection assignment matrix", () => {
  const ctx = withTestDb();

  it("filters by membership, searches secondary text, sorts, paginates, and hydrates covers", async () => {
    const direct = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Matrix Alpha",
        manufacturer: "Acme",
        tags: ["collection:painting"],
      }),
      ctx.actor,
    );
    await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Matrix Beta",
        manufacturer: "Zenith",
      }),
      ctx.actor,
    );
    const cover = await createImageFixture(ctx.db, "matrix-alpha-cover");
    await updateProduct(
      ctx.db,
      direct.entityId,
      { pendingImageIds: [cover.id] },
      ctx.actor,
    );

    const directOnly = await getCollectionMatrix(
      ctx.db,
      "product",
      "matrix",
      "secondary-desc",
      "painting",
      "direct",
      { pageIndex: 0, pageSize: 500 },
    );
    expect(directOnly.totalCount).toBe(1);
    expect(directOnly.rows[0]).toMatchObject({
      id: direct.id,
      name: "Matrix Alpha",
      secondary: "Acme",
      imageUrl: cover.url,
      states: { painting: "direct" },
    });

    const unassigned = await getCollectionMatrix(
      ctx.db,
      "product",
      "matrix",
      "secondary-desc",
      "painting",
      "unassigned",
      { pageIndex: 0, pageSize: 1 },
    );
    expect(unassigned.totalCount).toBe(1);
    expect(unassigned.rows.map((row) => row.name)).toEqual(["Matrix Beta"]);

    const manufacturerSearch = await getCollectionMatrix(
      ctx.db,
      "product",
      "zenith",
      "name-asc",
      undefined,
      undefined,
      { pageIndex: 0, pageSize: 500 },
    );
    expect(manufacturerSearch.rows.map((row) => row.name)).toEqual([
      "Matrix Beta",
    ]);

    const productBackedLocation = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Matrix Product-backed Location",
        type: null,
        productId: direct.id,
        tags: ["collection:painting"],
      }),
      ctx.actor,
    );
    const locations = await getCollectionMatrix(
      ctx.db,
      "location",
      "product-backed",
      "name-asc",
      undefined,
      undefined,
      { pageIndex: 0, pageSize: 500 },
    );
    expect(locations.rows[0]?.imageUrl).toBe(cover.url);

    const detail = await getCollectionDetail(ctx.db, "painting", undefined, {
      pageIndex: 0,
      pageSize: 50,
    });
    expect(detail?.roots[0]).toMatchObject({
      id: productBackedLocation.id,
      imageUrl: cover.url,
    });
    expect(detail?.products[0]).toMatchObject({
      id: direct.id,
      imageUrl: cover.url,
    });
  });
});
