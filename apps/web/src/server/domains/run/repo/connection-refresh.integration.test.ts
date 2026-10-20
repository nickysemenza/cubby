import { eq } from "drizzle-orm";
import { buildEntity } from "tooling/factories/build";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import {
  claimAiEvaluation,
  publishAiEvaluation,
} from "~/server/ai/repo/ai-evaluation";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  entityLink,
  expense,
  ingredient,
  inventoryEntry,
  location,
  product,
  run,
  user,
} from "~/server/db/schema";
import { connectionHandlers } from "~/server/domains/connection/operations/connection.server";
import { acquisitionPairEligible } from "~/server/domains/connection/repo/connection-candidates";
import { confirmPurchaseAcquisition } from "~/server/domains/purchase/repo/purchase-products";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { reconcileDerivedRefreshInputs } from "~/server/testing/background-queue";
import {
  createInventoryFixture,
  createIngredientFixture,
  createLocationFixture,
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  connectionSourceFingerprint,
  connectionSourceFingerprints,
  scheduleConnectionRefresh,
} from "./connection-refresh";
import { ensureRun, systemActor } from "./ensure-run";

const reconciledSourceFingerprint = async (
  ...args: Parameters<typeof connectionSourceFingerprint>
) => {
  await reconcileDerivedRefreshInputs(args[0]);
  return connectionSourceFingerprint(...args);
};

const each = (value: number) => ({ value, unit: "each" }) as const;

// Failure mode: completing a negative scan permanently hides a later endpoint,
// or a projection rebuild creates unnecessary new evaluations with identical content.
describe("connection discovery roster freshness", () => {
  const ctx = withTestDb();
  beforeEach(async () => {
    await getDb(ctx.db).insert(user).values({
      id: systemActor().userId,
      name: "Synthetic system",
      email: "synthetic-system@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  it.each(["failed", "dispatch_failed", "cancelled"] as const)(
    "returns the %s owner when explicit rediscovery finds its retained work",
    async (outcome) => {
      const source = await createRepoEntity(ctx, "task", {
        name: "Synthetic recoverable discovery",
        trade: "other",
      });
      const ref = { entityKind: "task" as const, entityId: source.output.id };
      await activateAiRefresh(ctx.db, "synthetic-explicit-recovery", {
        enabled: true,
      });
      const first = await scheduleConnectionRefresh(ctx.db, ref);
      if (!first.runId)
        throw new Error("Synthetic connection work was not scheduled");
      await getDb(ctx.db)
        .update(run)
        .set({
          status: outcome === "cancelled" ? "failed" : outcome,
          failureCode:
            outcome === "cancelled"
              ? "user_cancelled"
              : "ai_work_workflow_failed",
          dispatchError: "Synthetic retained Workflow diagnostic",
        })
        .where(eq(run.id, first.runId));
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({ state: outcome === "cancelled" ? "cancelled" : "queued" })
        .where(eq(aiEvaluation.runId, first.runId));
      const found = await scheduleConnectionRefresh(ctx.db, ref);
      expect(found).toMatchObject({
        kind: outcome === "cancelled" ? "stopped" : "recoverable",
        runId: first.runId,
      });
      if (outcome !== "cancelled")
        for (let index = 0; index < 2; index++)
          await ensureRun(ctx.db, systemActor(), {
            purpose: "ai_refresh",
            trigger: "scheduled",
            status: "running",
            clientKey: `synthetic-discovery-capacity:${index}`,
          });
      await expect(
        connectionHandlers.runs.discover!.run(
          {
            ...buildKernelContext(ctx.db, ctx.actor.userId),
            signal: new AbortController().signal,
          },
          ref,
        ),
      ).rejects.toThrow(
        outcome === "cancelled"
          ? "Synthetic retained Workflow diagnostic"
          : "no free Run slots",
      );
    },
  );
  // A page must not scan the same broad target corpus for every source.
  it("shares broad rosters within a batch and refreshes them on the next call", async () => {
    const first = await createRepoEntity(ctx, "task", {
      name: "Synthetic first batch source",
      trade: "other",
    });
    const second = await createRepoEntity(ctx, "task", {
      name: "Synthetic second batch source",
      trade: "other",
    });
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic batch target" }),
      ctx.actor,
    );
    const sources = [
      { entityKind: "task", entityId: second.output.id },
      { entityKind: "product", entityId: item.id },
      { entityKind: "task", entityId: first.output.id },
      { entityKind: "task", entityId: second.output.id },
    ] as const;
    const singles = [];
    for (const source of sources)
      singles.push(await reconciledSourceFingerprint(ctx.db, source));
    const batch = await countTestDbQueries(() =>
      connectionSourceFingerprints(ctx.db, sources),
    );
    expect(batch.result).toEqual(singles);
    const corpusQueries = batch.statements.filter((statement) =>
      statement.startsWith("select md5(coalesce(jsonb_agg("),
    );
    expect(corpusQueries).toEqual([]);
    const empty = await countTestDbQueries(() =>
      connectionSourceFingerprints(ctx.db, []),
    );
    expect(empty.result).toEqual([]);
    expect(empty.queryCount).toBe(0);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic renamed batch target" })
      .where(eq(product.id, item.entityId));
    await reconcileDerivedRefreshInputs(ctx.db);
    const after = await connectionSourceFingerprints(ctx.db, sources);
    expect(after).not.toEqual(batch.result);
    const current = [];
    for (const source of sources)
      current.push(await reconciledSourceFingerprint(ctx.db, source));
    expect(after).toEqual(current);
    await refreshSearchDocument(ctx.db, "product", item.entityId);
    const rebuilt = await connectionSourceFingerprints(ctx.db, sources);
    await refreshSearchDocument(ctx.db, "product", item.entityId);
    expect(await connectionSourceFingerprints(ctx.db, sources)).toEqual(
      rebuilt,
    );
  });
  // A Location has no outgoing discovery family. Unrelated records must not
  // invalidate its completed scan or fence an evaluation already in flight.
  it("keeps an unrelated mutation out of the source fingerprint", async () => {
    const source = await createLocationFixture(
      ctx.db,
      {
        name: "Synthetic stable source",
        type: "room",
        aliases: [],
      },
      ctx.actor,
    );
    const ref = { entityKind: "location" as const, entityId: source.id };
    const before = await reconciledSourceFingerprint(ctx.db, ref);
    await createLocationFixture(
      ctx.db,
      {
        name: "Synthetic unrelated room",
        type: "room",
        aliases: [],
      },
      ctx.actor,
    );
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(before);
  });
  it("revisits Product field inference after an Ingredient alias changes indexed retrieval", async () => {
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic alias source" }),
      ctx.actor,
    );
    const target = await createIngredientFixture(
      ctx.db,
      buildEntity("ingredient", { name: "Synthetic herb" }),
      ctx.actor,
    );
    const ref = { entityKind: "product" as const, entityId: source.id };
    const before = await reconciledSourceFingerprint(ctx.db, ref);
    await getDb(ctx.db)
      .update(ingredient)
      .set({ aliases: ["Synthetic alias source"] })
      .where(eq(ingredient.id, target.entityId));
    expect(await reconciledSourceFingerprint(ctx.db, ref)).not.toBe(before);
    await refreshSearchDocument(ctx.db, "ingredient", target.entityId);
    const changed = await reconciledSourceFingerprint(ctx.db, ref);
    expect(changed).not.toBe(before);
    await refreshSearchDocument(ctx.db, "ingredient", target.entityId);
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(changed);
  });
  it("includes indexed Product retrieval content for Task field inference", async () => {
    const source = await createRepoEntity(ctx, "task", {
      name: "Synthetic field retrieval source",
      trade: "other",
    });
    const target = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic indexed target" }),
      ctx.actor,
    );
    await refreshSearchDocument(ctx.db, "product", target.entityId);
    const ref = { entityKind: "task" as const, entityId: source.output.id };
    const before = await reconciledSourceFingerprint(ctx.db, ref);
    // The periodic backstop observes authoritative text changes before discovery.
    await getDb(ctx.db)
      .update(product)
      .set({ notes: "Synthetic retrieval content change" })
      .where(eq(product.id, target.entityId));
    expect(await reconciledSourceFingerprint(ctx.db, ref)).not.toBe(before);
  });
  it.each(["expense", "confirmation"] as const)(
    "revisits both acquisition endpoints after their %s acquisition blocker is removed",
    async (blocker) => {
      const vendor = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic acquisition supplier",
      });
      const order = await createRepoEntity(ctx, "purchase", {
        vendorId: vendor.output.id,
        notes: "Synthetic acquired tool",
      });
      const item = await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic acquired tool" }),
        ctx.actor,
      );
      const ref = {
        entityKind: "purchase" as const,
        entityId: order.output.id,
      };
      const productRef = { entityKind: "product" as const, entityId: item.id };
      if (blocker === "expense")
        await createRepoEntity(ctx, "expense", {
          name: "Synthetic acquired tool",
          cost: 20,
          trade: "electrical",
          costType: "tools",
          productId: item.id,
          purchaseId: order.output.id,
        });
      else
        await confirmPurchaseAcquisition(ctx.db, {
          purchaseId: order.output.id,
          productId: item.id,
        });
      expect(
        await acquisitionPairEligible(ctx.db, item.id, order.output.id),
      ).toBe(false);
      const before = await reconciledSourceFingerprint(ctx.db, ref);
      const beforeProduct = await reconciledSourceFingerprint(
        ctx.db,
        productRef,
      );
      if (blocker === "expense")
        await getDb(ctx.db)
          .update(expense)
          .set({ deletedAt: new Date() })
          .where(eq(expense.purchaseId, order.entityId));
      else
        await getDb(ctx.db)
          .update(entityLink)
          .set({ deletedAt: new Date() })
          .where(eq(entityLink.fromEntityId, order.entityId));
      expect(
        await acquisitionPairEligible(ctx.db, item.id, order.output.id),
      ).toBe(true);
      expect(await reconciledSourceFingerprint(ctx.db, ref)).not.toBe(before);
      expect(await reconciledSourceFingerprint(ctx.db, productRef)).not.toBe(
        beforeProduct,
      );
    },
  );
  it("advances conservative inventory epochs while ignoring verification-only changes", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic stock subject" }),
      ctx.actor,
    );
    const other = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic other stock" }),
      ctx.actor,
    );
    const unknown = await createLocationFixture(
      ctx.db,
      { name: "Unknown", type: "room", aliases: [] },
      ctx.actor,
    );
    const shelf = await createLocationFixture(
      ctx.db,
      { name: "Synthetic shelf", type: "shelf", aliases: [] },
      ctx.actor,
    );
    const stock = await createInventoryFixture(
      ctx.db,
      { productId: item.id, locationId: unknown.id, amount: each(1) },
      ctx.actor,
    );
    const ref = { entityKind: "inventory" as const, entityId: stock.id };
    const before = await reconciledSourceFingerprint(ctx.db, ref);
    await createInventoryFixture(
      ctx.db,
      { productId: other.id, locationId: shelf.id, amount: each(1) },
      ctx.actor,
    );
    expect(await reconciledSourceFingerprint(ctx.db, ref)).not.toBe(before);
    await createInventoryFixture(
      ctx.db,
      { productId: item.id, locationId: shelf.id, amount: each(1) },
      ctx.actor,
    );
    const withDestination = await reconciledSourceFingerprint(ctx.db, ref);
    expect(withDestination).not.toBe(before);
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ verifiedAt: new Date() })
      .where(eq(inventoryEntry.id, stock.entityId));
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(
      withDestination,
    );
    await getDb(ctx.db)
      .update(location)
      .set({ name: "Synthetic renamed shelf" })
      .where(eq(location.id, shelf.entityId));
    expect(await reconciledSourceFingerprint(ctx.db, ref)).not.toBe(
      withDestination,
    );
  });
  it("reschedules a completed negative scan for new, changed and retired endpoints", async () => {
    const source = await createRepoEntity(ctx, "task", {
      name: "Synthetic discovery source",
      trade: "other",
    });
    const ref = { entityKind: "task" as const, entityId: source.output.id };
    await activateAiRefresh(ctx.db, "synthetic-connection-roster", {
      enabled: true,
    });
    await reconcileDerivedRefreshInputs(ctx.db);
    const { runId: firstRun } = await scheduleConnectionRefresh(ctx.db, ref);
    if (!firstRun)
      throw new Error("Synthetic connection discovery was not scheduled");
    expect((await scheduleConnectionRefresh(ctx.db, ref)).runId).toBe(firstRun);
    const [first] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, firstRun));
    if (!first) throw new Error("Synthetic connection evaluation is missing");
    const claimed = await claimAiEvaluation(ctx.db, first.id);
    if (!claimed?.attemptToken)
      throw new Error("Synthetic evaluation was not claimed");
    await publishAiEvaluation(
      ctx.db,
      first.id,
      claimed.attemptToken,
      async () => ({ source: ref, discovered: true }),
    );
    const before = await reconciledSourceFingerprint(ctx.db, ref);
    expect((await scheduleConnectionRefresh(ctx.db, ref)).runId).toBeNull();

    await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(before);

    const endpoint = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic new endpoint" }),
      ctx.actor,
    );
    expect(await reconciledSourceFingerprint(ctx.db, ref)).not.toBe(before);
    await refreshSearchDocument(ctx.db, "product", endpoint.entityId);
    const afterInsert = await reconciledSourceFingerprint(ctx.db, ref);
    expect(afterInsert).not.toBe(before);
    expect((await scheduleConnectionRefresh(ctx.db, ref)).runId).toBe(firstRun);
    const refreshed = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, firstRun));
    expect(refreshed).toHaveLength(2);
    expect(refreshed.find((row) => row.id !== first.id)).toMatchObject({
      state: "queued",
      provenance: { inputFingerprint: afterInsert },
    });
    await refreshSearchDocument(ctx.db, "product", endpoint.entityId);
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(afterInsert);

    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic changed target" })
      .where(eq(product.id, endpoint.entityId));
    const afterContent = await reconciledSourceFingerprint(ctx.db, ref);
    expect(afterContent).not.toBe(afterInsert);
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, endpoint.entityId));
    expect(await reconciledSourceFingerprint(ctx.db, ref)).not.toBe(
      afterContent,
    );
  });
});
