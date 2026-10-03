import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { entityExternalId, product } from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";

import { findProductExternalIdCollisions } from "./external-id-collisions";

describe("product external-id ownership", () => {
  const ctx = withTestDb();

  it("names the single live owner of each identifier relative to the product being written", async () => {
    const owner = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "ForgeWear trail shirt, blue, medium" }),
      ctx.actor,
    );
    const other = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "ForgeWear trail shirt, blue, large" }),
      ctx.actor,
    );
    await withTransaction(ctx.db, async (tx) => {
      await ensureExternalSources(tx, ["amazon"]);
      await tx.insert(entityExternalId).values({
        entityId: owner.entityId,
        entityKind: "product" as const,
        source: "amazon",
        kind: "asin",
        externalId: "B0OWNED001",
        isPrimary: true,
      });
    });
    const shortcode = async (id: typeof owner.entityId) =>
      (
        await getDb(ctx.db)
          .select({ shortcode: product.shortcode })
          .from(product)
          .where(eq(product.id, id))
      )[0]!.shortcode;
    const identifiers = [
      { source: "Amazon", kind: "asin", externalId: "B0OWNED001" },
      { source: "amazon", kind: "asin", externalId: "B0MISSING1" },
    ];

    const asOther = await findProductExternalIdCollisions(ctx.db, {
      productId: await shortcode(other.entityId),
      identifiers,
    });
    expect(asOther.results.map((row) => row.status)).toEqual([
      "owned_by_other",
      "missing",
    ]);
    expect(asOther.results[0]?.products).toEqual([
      {
        id: await shortcode(owner.entityId),
        name: "ForgeWear trail shirt, blue, medium",
      },
    ]);

    const asOwner = await findProductExternalIdCollisions(ctx.db, {
      productId: await shortcode(owner.entityId),
      identifiers,
    });
    expect(asOwner.results[0]?.status).toBe("owned_by_this");
    const unscoped = await findProductExternalIdCollisions(ctx.db, {
      identifiers,
    });
    expect(unscoped.results[0]?.status).toBe("unique");
  });
});
