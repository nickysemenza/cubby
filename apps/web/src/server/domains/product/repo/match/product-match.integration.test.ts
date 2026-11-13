import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { insertFieldsFixture as insert } from "~/server/ai/fields/fields.fixtures";
import { getDb } from "~/server/db/helpers";
import { decision } from "~/server/db/kernel-schema";
import {
  expense,
  inventoryEntry,
  productIdentityObservation,
  product as productTable,
} from "~/server/db/schema";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import {
  listProductMatchRows,
  upsertAgentProductMatch,
} from "~/server/domains/product/repo/match/product-match-candidate";
import { getProductMatchQueue } from "~/server/domains/product/repo/match/product-match-review";
import {
  kernelCtx,
  productFixture,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

describe("Product identity decisions", () => {
  const ctx = withTestDb();
  async function pair() {
    const older = await productFixture(ctx, "Synthetic older product", {
      model: "SYNTHETIC-SAME",
    });
    const newer = await productFixture(ctx, "Synthetic chosen product", {
      model: "SYNTHETIC-SAME",
    });
    const proposal = await upsertAgentProductMatch(ctx.db, {
      productIds: [older.entityId, newer.entityId],
      evidence: "Synthetic reviewed identity",
      sourceUrls: [],
    });
    return { older, newer, proposal };
  }
  it("reads accepted pair evidence without discovering on read and retains a distinct decision on replay", async () => {
    const f = await pair();
    const before = await getDb(ctx.db)
      .select()
      .from(productIdentityObservation);
    expect(
      (await getProductMatchQueue(ctx.db, { productId: f.older.id })).items,
    ).toHaveLength(1);
    expect(
      await getDb(ctx.db).select().from(productIdentityObservation),
    ).toEqual(before);
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: f.proposal.id,
      operationId: "synthetic-distinct",
      verdict: "dismissed",
      expectedFingerprint: f.proposal.fingerprint!,
    });
    await upsertAgentProductMatch(ctx.db, {
      productIds: [f.older.entityId, f.newer.entityId],
      evidence: "Synthetic fresh description",
      sourceUrls: [],
    });
    expect(
      (await getProductMatchQueue(ctx.db, { productId: f.older.id })).items,
    ).toEqual([]);
    expect(
      (await listProductMatchRows(ctx.db, f.older.entityId))[0]?.state,
    ).toBe("dismissed");
  });
  it("applies a same decision once, keeps the requested newer survivor and conserves stock and spending references", async () => {
    const f = await pair();
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic merge shelf" }),
      ctx.actor,
    );
    for (const row of [f.older, f.newer])
      await createInventoryEntry(
        ctx.db,
        {
          productId: row.entityId,
          locationId: shelf.entityId,
          amount: { value: 2, unit: "each" },
        },
        ctx.actor,
      );
    const line = await insert(ctx.db, "expense", {
      name: "Synthetic owned line",
      productId: f.older.entityId,
      cost: 1000n,
      costType: "materials",
      trade: "other",
      lineKind: "principal",
      lineBasis: "item_line",
      economicRole: "vendor",
      date: "2026-10-01",
      productQuantity: 1,
    });
    const fresh = await upsertAgentProductMatch(ctx.db, {
      productIds: [f.older.entityId, f.newer.entityId],
      evidence: "Synthetic merge after stocking",
      sourceUrls: [],
    });
    const command = {
      suggestionId: fresh.id,
      operationId: "synthetic-same",
      verdict: "correct" as const,
      intent: "apply" as const,
      expectedFingerprint: fresh.fingerprint!,
      application: {
        kind: "product_merge" as const,
        keepId: f.newer.id,
        mergeId: f.older.id,
      },
    };
    const result = await reviewSuggestion(ctx.db, kernelCtx(ctx), command);
    expect(result.applied).toBe(true);
    const decisions = await getDb(ctx.db).select().from(decision);
    expect(await reviewSuggestion(ctx.db, kernelCtx(ctx), command)).toEqual(
      result,
    );
    await expect(
      reviewSuggestion(ctx.db, kernelCtx(ctx), {
        ...command,
        application: {
          ...command.application,
          keepId: f.older.id,
          mergeId: f.newer.id,
        },
      }),
    ).rejects.toThrow(/already used/);
    expect(await getDb(ctx.db).select().from(decision)).toEqual(decisions);
    const products = await getDb(ctx.db).select().from(productTable);
    expect(
      products.filter((row) => !row.deletedAt).map((row) => row.id),
    ).toEqual([f.newer.entityId]);
    const stock = await getDb(ctx.db)
      .select()
      .from(inventoryEntry)
      .where(eq(inventoryEntry.productId, f.newer.entityId));
    expect(
      stock.reduce((total, row) => total + Number(row.amountValue), 0),
    ).toBe(4);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(expense)
          .where(eq(expense.id, line.id))
      )[0],
    ).toMatchObject({ productId: f.newer.entityId, cost: 1000n });
  });
});
