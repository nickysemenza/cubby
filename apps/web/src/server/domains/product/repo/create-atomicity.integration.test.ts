import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { createProductWithFood } from "~/server/domains/product/repo/write/product-writes";
import { AppError } from "~/server/errors/app-error";
import { makeProductInput } from "~/server/testing/repo.fixtures";

import { createProduct } from "./crud";

describe("product create atomicity", () => {
  const ctx = withTestDb();

  it("rolls the insert back when the in-transaction data-quality read fails", async () => {
    const name = "Atomicity probe (quality read fails)";

    await expect(
      createProduct(ctx.db, makeProductInput({ name }), ctx.actor, {
        loadProductDataQualities: async () => {
          throw new Error("simulated transient read failure");
        },
      }),
    ).rejects.toThrow("simulated transient read failure");

    const rows = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(eq(product.name, name));
    expect(rows).toEqual([]);
  });

  it("names the committed product when only the post-commit read-back fails", async () => {
    const name = "Atomicity probe (read-back fails)";
    const usdaClient = {
      findFood: async () => {
        throw new Error("USDA is down");
      },
      findFoodsBatch: async () => {
        throw new Error("USDA is down");
      },
    };

    const attempt = createProductWithFood(
      ctx.db,
      usdaClient,
      makeProductInput({ name, fdc_id: 174277 }),
      ctx.actor,
    );

    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toThrow(
      /was created, but reading it back failed/,
    );
    const rows = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.name, name));
    expect(rows).toHaveLength(1);
    await expect(attempt).rejects.toThrow(rows[0]?.shortcode);
  });
});
