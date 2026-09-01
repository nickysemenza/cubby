import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { findProductByGtin, getProductByID } from "~/server/repo/product";
import {
  createProductFixture as createProduct,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

describe("product identity constraints", () => {
  const ctx = withTestDb();

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
