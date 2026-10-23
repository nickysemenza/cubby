import { eq } from "drizzle-orm";
import { createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

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
  inventoryEntry,
  location,
  product,
  run,
} from "~/server/db/schema";
import { connectionHandlers } from "~/server/domains/connection/operations/connection.server";
import { acquisitionPairEligible } from "~/server/domains/connection/repo/connection-candidates";
import { captureConnectionBasis } from "~/server/domains/connection/repo/connection-evidence";
import {
  publishEntityConnection,
  readEntityConnections,
} from "~/server/domains/connection/repo/entity-connections";
import { confirmPurchaseAcquisition } from "~/server/domains/purchase/repo/purchase-products";
import { getEntityRecommendations } from "~/server/domains/recommendation/service/entity-recommendations.service";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { systemPrincipal } from "~/server/http/authenticate";
import {
  reconcileDerivedRefreshInputs,
  withJobFixtureExecution,
} from "~/server/testing/background-queue";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import {
  connectionSourceFingerprint,
  connectionSourceFingerprints,
  scheduleConnectionRefresh,
} from "./connection-refresh";
import { ensureRun } from "./ensure-run";

const reconciledSourceFingerprint = async (
  ...args: Parameters<typeof connectionSourceFingerprint>
) => {
  await reconcileDerivedRefreshInputs(args[0]);
  return connectionSourceFingerprint(...args);
};

const each = (value: number) => ({ value, unit: "each" }) as const;

// Retained boundary after removing corpus epochs: endpoint-owned scheduling,
// source changes reopening negative scans, and stale published evidence hiding.
// acquisition-discovery retains retrieval gates; field-input-fence retains stale
// basis rejection on apply and unchanged-save advice availability.
describe("connection discovery source freshness", () => {
  const ctx = withTestDb();
  it.each(["failed", "dispatch_failed", "cancelled"] as const)(
    "keeps the %s owner stopped when explicit rediscovery finds its retained work",
    async (outcome) => {
      const source = await createRepoIdentity(ctx, "task", {
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
        kind: "stopped",
        runId: first.runId,
        diagnostic: expect.stringContaining(
          "Synthetic retained Workflow diagnostic",
        ),
      });
      await expect(
        connectionHandlers.operations.discover({
          data: ref,
          request: {
            principal: systemPrincipal(
              buildKernelContext(ctx.db, ctx.actor.userId),
            ),
            headers: new Headers(),
            signal: new AbortController().signal,
          },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining(
            "Synthetic retained Workflow diagnostic",
          ),
        },
      });
      const [retained] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, first.runId));
      expect(retained).toMatchObject({
        status: outcome === "cancelled" ? "failed" : outcome,
        dispatchError: "Synthetic retained Workflow diagnostic",
      });
    },
  );
  it("preserves batch order and changes only the edited source fingerprint", async () => {
    const first = await createRepoIdentity(ctx, "task", {
      name: "Synthetic first batch source",
      trade: "other",
    });
    const second = await createRepoIdentity(ctx, "task", {
      name: "Synthetic second batch source",
      trade: "other",
    });
    const item = await createProductIdentityFixture(
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
    await reconcileDerivedRefreshInputs(ctx.db);
    const singles = [];
    for (const source of sources)
      singles.push(await connectionSourceFingerprint(ctx.db, source));
    const batch = await countTestDbQueries(() =>
      connectionSourceFingerprints(ctx.db, sources),
    );
    expect(batch.result).toEqual(singles);
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
    expect(after[0]).toBe(batch.result[0]);
    expect(after[1]).not.toBe(batch.result[1]);
    expect(after[2]).toBe(batch.result[2]);
    expect(after[3]).toBe(batch.result[3]);
    const current = [];
    for (const source of sources)
      current.push(await connectionSourceFingerprint(ctx.db, source));
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
  it.each(["expense", "confirmation"] as const)(
    "refreshes acquisition eligibility and evidence after the %s blocker is removed",
    async (blocker) => {
      const vendor = await createRepoIdentity(ctx, "vendor", {
        name: "Synthetic acquisition supplier",
      });
      const order = await createRepoIdentity(ctx, "purchase", {
        vendorId: vendor.output.id,
        notes: "Synthetic acquired tool",
      });
      const item = await createProductIdentityFixture(
        ctx.db,
        makeProductInput({ name: "Synthetic acquired tool" }),
        ctx.actor,
      );
      const candidate = {
        relation: "product-purchase" as const,
        source: { entityKind: "product" as const, entityId: item.id },
        target: { entityKind: "purchase" as const, entityId: order.output.id },
        label: "Connect acquisition purchase",
        evidence: {
          reasons: ["Synthetic matching acquisition"],
          contradictions: [],
          unknowns: ["Member review required"],
        },
      };
      if (blocker === "expense")
        await createRepoIdentity(ctx, "expense", {
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
      const before = await captureConnectionBasis(ctx.db, candidate);
      await expect(publishEntityConnection(ctx.db, candidate)).rejects.toThrow(
        /eligible|already acquired/i,
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
      expect(await captureConnectionBasis(ctx.db, candidate)).not.toEqual(
        before,
      );
      const proposal = await publishEntityConnection(ctx.db, candidate);
      expect(await readEntityConnections(ctx.db, candidate.source)).toEqual([
        expect.objectContaining({ review: proposal.review }),
      ]);
    },
  );
  it("refreshes inventory destination evidence without invalidating an unchanged source", async () => {
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic stock subject" }),
      ctx.actor,
    );
    const other = await createProductIdentityFixture(
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
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(before);
    expect((await getEntityRecommendations(ctx.db, ref)).groups).toEqual([
      expect.objectContaining({ kind: "inventory-placement", proposals: [] }),
    ]);
    await createInventoryFixture(
      ctx.db,
      { productId: item.id, locationId: shelf.id, amount: each(1) },
      ctx.actor,
    );
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(before);
    expect((await getEntityRecommendations(ctx.db, ref)).groups).toEqual([
      expect.objectContaining({
        kind: "inventory-placement",
        proposals: [
          expect.objectContaining({
            target: { id: shelf.id, name: "Synthetic shelf" },
          }),
        ],
      }),
    ]);
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ verifiedAt: new Date() })
      .where(eq(inventoryEntry.id, stock.entityId));
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(before);
    const proposal = await publishEntityConnection(ctx.db, {
      relation: "inventory-location",
      source: ref,
      target: { entityKind: "location", entityId: shelf.id },
      label: "Review inventory placement",
      evidence: {
        reasons: ["Synthetic exact-product stock destination"],
        contradictions: [],
        unknowns: ["Member review required"],
      },
    });
    expect(await readEntityConnections(ctx.db, ref)).toEqual([
      expect.objectContaining({ review: proposal.review }),
    ]);
    await getDb(ctx.db)
      .update(location)
      .set({ name: "Synthetic renamed shelf" })
      .where(eq(location.id, shelf.entityId));
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(before);
    expect(await readEntityConnections(ctx.db, ref)).toEqual([]);
    await getDb(ctx.db)
      .update(inventoryEntry)
      .set({ amountValue: 2 })
      .where(eq(inventoryEntry.id, stock.entityId));
    expect(await reconciledSourceFingerprint(ctx.db, ref)).not.toBe(before);
  });
  it("schedules each endpoint's own changes and hides stale evidence after a negative scan", async () => {
    const source = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic discovery source" }),
      ctx.actor,
    );
    const ref = { entityKind: "product" as const, entityId: source.id };
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
    await withJobFixtureExecution(
      ctx.db,
      {
        key: `ai-evaluation:${first.id}`,
        kind: "ai.evaluation",
        input: { evaluationId: first.id },
      },
      async () => {
        const claimed = await claimAiEvaluation(ctx.db, first.id);
        if (!claimed?.attemptToken)
          throw new Error("Synthetic evaluation was not claimed");
        await publishAiEvaluation(
          ctx.db,
          first.id,
          claimed.attemptToken,
          async () => ({ source: ref, discovered: true }),
        );
      },
    );
    const before = await reconciledSourceFingerprint(ctx.db, ref);
    expect((await scheduleConnectionRefresh(ctx.db, ref)).runId).toBeNull();

    await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(before);

    const endpoint = await createRepoIdentity(ctx, "expense", {
      name: "Synthetic new endpoint",
      cost: 18,
      trade: "electrical",
      costType: "tools",
    });
    const endpointRef = {
      entityKind: "expense" as const,
      entityId: endpoint.output.id,
    };
    expect(await reconciledSourceFingerprint(ctx.db, ref)).toBe(before);
    expect(await scheduleConnectionRefresh(ctx.db, ref)).toMatchObject({
      kind: "unchanged",
      runId: null,
    });
    const endpointFingerprint = await connectionSourceFingerprint(
      ctx.db,
      endpointRef,
    );
    const scheduledEndpoint = await scheduleConnectionRefresh(
      ctx.db,
      endpointRef,
    );
    expect(scheduledEndpoint.kind).toBe("scheduled");
    if (scheduledEndpoint.kind !== "scheduled")
      throw new Error("Synthetic endpoint discovery was not scheduled");
    const endpointEvaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, scheduledEndpoint.runId));
    expect(endpointEvaluations).toContainEqual(
      expect.objectContaining({
        state: "queued",
        target: expect.objectContaining({
          entity: "expense",
          recordId: endpoint.entityId,
        }),
        provenance: expect.objectContaining({
          inputFingerprint: endpointFingerprint,
        }),
      }),
    );
    const candidate = {
      relation: "product-expense" as const,
      source: ref,
      target: endpointRef,
      label: "Connect acquisition charge",
      evidence: {
        reasons: ["Synthetic matching acquisition"],
        contradictions: [],
        unknowns: ["Member review required"],
      },
    };
    const proposal = await publishEntityConnection(ctx.db, candidate);
    expect(await readEntityConnections(ctx.db, ref)).toEqual([
      expect.objectContaining({ review: proposal.review }),
    ]);

    await getDb(ctx.db)
      .update(expense)
      .set({ name: "Synthetic changed target" })
      .where(eq(expense.id, endpoint.entityId));
    expect(await readEntityConnections(ctx.db, ref)).toEqual([]);
    expect(await readEntityConnections(ctx.db, endpointRef)).toEqual([]);
    expect(await scheduleConnectionRefresh(ctx.db, ref)).toMatchObject({
      kind: "unchanged",
      runId: null,
    });
    const changedEndpointFingerprint = await connectionSourceFingerprint(
      ctx.db,
      endpointRef,
    );
    expect(changedEndpointFingerprint).not.toBe(endpointFingerprint);
    const changedEndpoint = await scheduleConnectionRefresh(
      ctx.db,
      endpointRef,
    );
    expect(changedEndpoint.kind).toBe("scheduled");
    if (changedEndpoint.kind !== "scheduled")
      throw new Error("Synthetic changed endpoint discovery was not scheduled");
    const changedEvaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, changedEndpoint.runId));
    expect(changedEvaluations).toContainEqual(
      expect.objectContaining({
        state: "queued",
        target: expect.objectContaining({
          entity: "expense",
          recordId: endpoint.entityId,
        }),
        provenance: expect.objectContaining({
          inputFingerprint: changedEndpointFingerprint,
        }),
      }),
    );
    const fresh = await publishEntityConnection(ctx.db, candidate);
    expect(fresh.review.assessmentId).not.toBe(proposal.review.assessmentId);
    expect(await readEntityConnections(ctx.db, ref)).toEqual([
      expect.objectContaining({ review: fresh.review }),
    ]);
    await refreshSearchDocument(ctx.db, "expense", endpoint.entityId);
    expect(await scheduleConnectionRefresh(ctx.db, endpointRef)).toMatchObject({
      kind: "unchanged",
      runId: changedEndpoint.runId,
    });

    await deleteThroughKernel(ctx.db, ctx.actor, "expense", [
      endpoint.output.id,
    ]);
    expect(await readEntityConnections(ctx.db, ref)).toEqual([]);
    await expect(
      scheduleConnectionRefresh(ctx.db, endpointRef),
    ).rejects.toThrow(/no longer exists|not found/);
    expect(await scheduleConnectionRefresh(ctx.db, ref)).toMatchObject({
      kind: "unchanged",
      runId: null,
    });

    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic changed discovery source" })
      .where(eq(product.id, source.entityId));
    const changedSourceFingerprint = await connectionSourceFingerprint(
      ctx.db,
      ref,
    );
    expect(changedSourceFingerprint).not.toBe(before);
    const changedSource = await scheduleConnectionRefresh(ctx.db, ref);
    expect(changedSource.kind).toBe("scheduled");
    if (changedSource.kind !== "scheduled")
      throw new Error("Synthetic changed source discovery was not scheduled");
    const sourceEvaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, changedSource.runId));
    expect(sourceEvaluations).toContainEqual(
      expect.objectContaining({
        state: "queued",
        target: expect.objectContaining({
          entity: "product",
          recordId: source.entityId,
        }),
        provenance: expect.objectContaining({
          inputFingerprint: changedSourceFingerprint,
        }),
      }),
    );
  });
});
