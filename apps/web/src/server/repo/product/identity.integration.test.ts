import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  deleteProducts,
  findProductByGtin,
  getProductByID,
  patchProductExternalIds,
} from "~/server/repo/product";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import {
  countProductsByFoodIdentifiers,
  findProductsByFoodIdentifiers,
} from "./lookup";

describe("product identity constraints", () => {
  const ctx = withTestDb();

  it("counts live USDA links with the same FDC and normalized barcode semantics as the product projection", async () => {
    const linked = await createProduct(
      ctx.db,
      makeProductInput({
        name: "USDA identity linked product",
        fdc_id: 880001,
        upc: "012345678905",
      }),
      ctx.actor,
    );
    const removed = await createProduct(
      ctx.db,
      makeProductInput({
        name: "USDA identity removed product",
        fdc_id: 880001,
      }),
      ctx.actor,
    );
    await deleteProducts(ctx.db, [removed.entityId], ctx.actor);
    const lookups = [
      { kind: "fdc", fdc_id: 880001 },
      { kind: "upc", gtin_upc: "0012345678905" },
      { kind: "fdc", fdc_id: 880002 },
    ] as const;
    expect(await countProductsByFoodIdentifiers(ctx.db, lookups)).toEqual([
      1, 1, 0,
    ]);
    expect(
      (await findProductsByFoodIdentifiers(ctx.db, lookups)).map((products) =>
        products.map((product) => product.id),
      ),
    ).toEqual([[linked.id], [linked.id], []]);
    await patchProductExternalIds(
      ctx.db,
      linked.entityId,
      {
        upsert: [],
        remove: [
          {
            source: "gtin",
            kind: "gtin_14",
            expectedExternalId: "00012345678905",
          },
        ],
      },
      ctx.actor,
    );
    // The FDC match still selects the product; its retired barcode must not
    // count as a live link when several food identities are queried together.
    expect(await countProductsByFoodIdentifiers(ctx.db, lookups)).toEqual([
      1, 0, 0,
    ]);
    expect(
      (await findProductsByFoodIdentifiers(ctx.db, lookups)).map((products) =>
        products.map((product) => product.id),
      ),
    ).toEqual([[linked.id], [], []]);
    expect(await countProductsByFoodIdentifiers(ctx.db, [])).toEqual([]);
  });

  it("preserves model identity and rejects name, GTIN, and external-ID collisions", async () => {
    const canonical = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Identity Drill",
        manufacturer: "Acme",
        model: "ID-100",
        upc: "077089850017",
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B0IDENTITY1",
            url: null,
          },
        ],
      }),
      ctx.actor,
    );

    expect((await getProductByID(ctx.db, canonical.entityId)).model).toBe(
      "ID-100",
    );
    await expect(
      createProduct(
        ctx.db,
        makeProductInput({
          name: "Identity Drill",
          manufacturer: "Acme",
          model: "ID-200",
          upc: "123456789012",
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(new RegExp(`already exists: ${canonical.id}`));

    await expect(
      createProduct(
        ctx.db,
        makeProductInput({
          name: "Encoded Identity Drill",
          manufacturer: "Other",
          upc: "0077089850017",
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(
      new RegExp(
        `gtin/gtin_14/00077089850017 already belongs to ${canonical.id}`,
      ),
    );

    await expect(
      createProduct(
        ctx.db,
        makeProductInput({
          name: "External Identity Drill",
          manufacturer: "Other",
          externalIds: [
            {
              source: "amazon",
              kind: "asin",
              externalId: "B0IDENTITY1",
              url: null,
            },
          ],
        }),
        ctx.actor,
      ),
    ).rejects.toThrow(new RegExp(`already belongs to ${canonical.id}`));

    const found = await findProductByGtin(ctx.db, "0077089850017");
    expect(found?.id).toBe(canonical.id);
    expect(found?.primaryGtin).toBe("00077089850017");
  });
});
