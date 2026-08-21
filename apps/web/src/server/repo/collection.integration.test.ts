import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getCollectionDetail, getCollectionMatrix } from "./collection";
import { createExpense } from "./expense";
import { updateProduct } from "./product";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
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
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Matrix Shelf", type: "shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: direct.id,
        locationId: shelf.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Matrix paint tool",
        productId: direct.id,
        vendor: "Matrix Supply",
        orderId: "MATRIX-42",
        trade: "finishes",
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Matrix hardware",
        productId: direct.id,
        vendor: "Matrix Supply",
        orderId: "MATRIX-42",
        trade: "metalworking",
      }),
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
      placements: [
        {
          id: shelf.id,
          name: "Matrix Shelf",
          path: ["Home", "Matrix Shelf"],
        },
      ],
      purchases: [
        {
          orderId: "MATRIX-42",
          vendorName: "Matrix Supply",
          trades: ["finishes", "metalworking"],
        },
      ],
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
    expect(locations.rows[0]).toMatchObject({
      imageUrl: cover.url,
      placements: [],
      purchases: [],
    });

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
      placements: expect.arrayContaining([
        expect.objectContaining({ id: shelf.id }),
        expect.objectContaining({ id: productBackedLocation.id }),
      ]),
      purchases: [
        expect.objectContaining({
          orderId: "MATRIX-42",
          trades: ["finishes", "metalworking"],
        }),
      ],
    });
  });

  it("does not list a product-backed Location as its own Collection content", async () => {
    const container = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Painting Tote" }),
      ctx.actor,
    );
    const contents = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Brush Inside Painting Tote" }),
      ctx.actor,
    );
    const studio = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Painting Studio",
        type: "area",
        tags: ["collection:painting"],
      }),
      ctx.actor,
    );
    const tote = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Painting Tote",
        parentId: studio.id,
        type: null,
        productId: container.id,
      }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: contents.id,
        locationId: tote.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );

    const detail = await getCollectionDetail(ctx.db, "painting", undefined, {
      pageIndex: 0,
      pageSize: 50,
    });

    expect(detail?.collection.productCount).toBe(1);
    expect(detail?.totalCount).toBe(1);
    expect(detail?.products.map((item) => item.id)).toEqual([contents.id]);
  });
});
