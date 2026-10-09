import { runEntityId } from "@cubby/schemas/identifiers";
import {
  acceptedSourceOrder,
  type PurchaseAgentEvent,
} from "@cubby/schemas/purchase-import";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import {
  productResearchRunInput,
  purchaseValidationResearchRunInput,
} from "@cubby/schemas/run-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { asc, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import {
  expense,
  importSourceClaim,
  importSourceOrder,
  inventoryEntry,
  run,
  runEvidence,
  runFactEvidence,
  runOperation,
  runTarget,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { mergeProducts } from "~/server/repo/product/merge";
import { mergePurchases } from "~/server/repo/purchase";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { startProductResearch } from "./product-research-run";
import { productResearchFixture } from "./product-research.fixtures";
import { startPurchaseValidationResearch } from "./purchase-validation-research";
import { resolveImportResearch } from "./research-import";
import {
  retainResearchObservation,
  type ResearchObservationPorts,
} from "./research-observations";
import { resolveProductResearch } from "./research-product";
import { researchServiceFor } from "./research-service";
import { controlRun } from "./run-service";

// Ordinary merges must preserve admitted task identities, settled receipts and
// retained originals. Fresh continuations use the survivor's current context;
// cached acceptance never authorizes new writes against a stale snapshot.
describe("admitted research subjects through ordinary merges", () => {
  const ctx = withTestDb();
  afterEach(() => setCfEnv(undefined));

  function externalPorts() {
    const bytes = new Map<string, Uint8Array>();
    const storage = {
      put: async (key, value) => {
        bytes.set(key, value);
      },
      get: async (key) => {
        const value = bytes.get(key);
        if (!value) throw new Error("Synthetic retained original missing.");
        return new TextDecoder().decode(value);
      },
    } satisfies NonNullable<ResearchObservationPorts["storage"]>;
    const events: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => void events.push(event),
    };
    const environment = fromPartial<Env>({ PURCHASE_AGENT_QUEUE: queue });
    setCfEnv(environment);
    return {
      storage,
      queue,
      environment,
      readEvidence: (row: typeof runEvidence.$inferSelect) =>
        storage.get(row.objectKey),
    };
  }

  async function savedRun(id: typeof run.$inferSelect.id) {
    const [row] = await getDb(ctx.db).select().from(run).where(eq(run.id, id));
    if (!row) throw new Error("Synthetic research Run missing.");
    return row;
  }

  async function tasks(id: typeof run.$inferSelect.id) {
    return getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, id))
      .orderBy(asc(runTarget.id));
  }

  it("preserves both original Product tasks and completed replay, then retries only the current survivor", async () => {
    const ports = externalPorts();
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      kind: "member",
      userId: ctx.actor.userId,
      name: "Synthetic merge research member",
    });
    const products = [];
    for (const name of [
      "Synthetic canonical device",
      "Synthetic duplicate device",
    ])
      products.push(
        await createProductFixture(
          ctx.db,
          makeProductInput({
            name,
            manufacturer: "Example Works",
            model: "Q-17",
          }),
          ctx.actor,
        ),
      );
    const [keeper, loser] = products;
    if (!keeper || !loser) throw new Error("Synthetic merge Products missing.");
    const [started] = await startProductResearch(
      ctx.db,
      {
        ledgerPartyId: party.id,
        userId: ctx.actor.userId,
        productIds: products.map((item) => item.entityId),
        cause: "member_request",
      },
      ports.queue,
    );
    if (!started) throw new Error("Synthetic Product admission missing.");
    const admitted = await savedRun(started.runId);
    const frozenInput = structuredClone(admitted.input);
    const targets = await tasks(admitted.id);
    expect(targets).toHaveLength(2);
    const selected = targets.find(
      (target) => target.entityId === loser.entityId,
    );
    const other = targets.find((target) => target.entityId === keeper.entityId);
    if (!selected || !other)
      throw new Error("Synthetic admitted tasks missing.");
    const service = researchServiceFor(ctx.db, ports.environment, admitted.id, {
      observations: { storage: ports.storage },
    });
    expect(await service.researchNext({}, crypto.randomUUID())).toMatchObject({
      status: "working",
    });
    const original = await retainResearchObservation(
      ctx.db,
      {
        runId: admitted.id,
        workRef: selected.id,
        callId: crypto.randomUUID(),
        kind: "web_page",
        sourceMetadata: { sourceURL: "https://catalog.example.test/q-17" },
        content: "<main>Manufacturer Example Works. Model Q-17.</main>",
      },
      { storage: ports.storage },
    );
    const proposal = researchWorkResolve.parse({
      workRef: selected.id,
      status: "partially_verified",
      identity: {
        evidenceIds: [original.evidenceId],
        reasoning: "The retained label identifies this exact device.",
      },
      facts: ["manufacturer", "model"].map((fieldPath, index) => ({
        fieldPath,
        value: index === 0 ? "Example Works" : "Q-17",
        evidenceId: original.evidenceId,
        support: {
          observation: "Manufacturer Example Works. Model Q-17.",
          reasoning: "The exact model label supports this existing value.",
        },
      })),
      detail:
        "Matching identity is supported; other catalog coverage remains unresolved.",
    });
    const callId = crypto.randomUUID();
    let assessments = 0;
    const accepted = await resolveProductResearch(
      ctx.db,
      { runId: admitted.id, callId, proposal },
      {
        readEvidence: ports.readEvidence,
        assess: async () => {
          assessments++;
          return {
            identityVerified: true,
            acceptedFacts: [0, 1],
            acceptedIdentifiers: [],
            acceptedImages: [],
            rejected: [],
          };
        },
      },
    );
    expect(accepted).toMatchObject({
      changedFields: [],
      verifiedFields: ["manufacturer", "model"],
    });
    const delivered = await service.researchResolve(proposal, callId);
    const refusal = researchWorkResolve.parse({
      workRef: other.id,
      status: "no_source_found",
      identity: {
        evidenceIds: [],
        reasoning: "No exact original was found for this selected task.",
      },
      detail: "Retain the selected Product without new facts.",
    });
    const refusalCall = crypto.randomUUID();
    await resolveProductResearch(
      ctx.db,
      { runId: admitted.id, callId: refusalCall, proposal: refusal },
      {
        assess: async () => ({
          identityVerified: false,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          rejected: [],
        }),
      },
    );
    expect(await service.researchResolve(refusal, refusalCall)).toMatchObject({
      status: "done",
    });
    const settled = await savedRun(admitted.id);
    expect(settled).toMatchObject({
      status: "needs_review",
      input: frozenInput,
    });
    const beforeTasks = await tasks(admitted.id);
    const beforeEvidence = await getDb(ctx.db).select().from(runEvidence);
    const beforeProof = await getDb(ctx.db)
      .select()
      .from(runFactEvidence)
      .orderBy(asc(runFactEvidence.id));
    const beforeReceipts = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .orderBy(asc(runOperation.id));

    await mergeProducts(
      ctx.db,
      { keepId: keeper.id, mergeIds: [loser.id] },
      ctx.actor,
    );

    expect.soft(await tasks(admitted.id)).toMatchObject(
      beforeTasks.map(({ updatedAt: _updated, ...target }) => ({
        ...target,
        entityId: keeper.entityId,
        workKey: target.entityId,
      })),
    );
    expect(await savedRun(admitted.id)).toEqual(settled);
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual(
      beforeEvidence,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .orderBy(asc(runFactEvidence.id)),
    ).toEqual(
      beforeProof.map((proof) => ({ ...proof, entityId: keeper.entityId })),
    );
    expect(await service.researchResolve(proposal, callId)).toEqual(delivered);
    expect(assessments).toBe(1);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .orderBy(asc(runOperation.id)),
    ).toEqual(beforeReceipts);
    await expect(resolveOrThrow(ctx.db, "product", loser.id)).rejects.toThrow(
      /merged|not found|deleted/iu,
    );

    const retry = await controlRun(ctx.db, ctx.actor, {
      runPublicId: settled.shortcode,
      action: "retry",
    });
    if (!("successorRunId" in retry) || !retry.successorRunId)
      throw new Error("Synthetic Product retry missing.");
    const successor = await savedRun(runEntityId.parse(retry.successorRunId));
    const saved = productResearchRunInput.parse(successor.input);
    expect(saved.products).toMatchObject([{ productId: keeper.entityId }]);
    expect(saved.products).toHaveLength(1);
    expect(saved.products[0]?.contextFingerprint).not.toBe(
      productResearchRunInput
        .parse(frozenInput)
        .products.find((entry) => entry.productId === loser.entityId)
        ?.contextFingerprint,
    );
    expect(await tasks(successor.id)).toMatchObject([
      { entityId: keeper.entityId, workKey: keeper.entityId, state: "pending" },
    ]);
    expect(
      await researchServiceFor(
        ctx.db,
        ports.environment,
        successor.id,
      ).researchNext({}, crypto.randomUUID()),
    ).toMatchObject({
      status: "working",
      work: { kind: "product", product: { productRef: keeper.id } },
    });
    expect(await savedRun(admitted.id)).toEqual(settled);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });

  it("replays a merged Purchase's completed validation and carries its exact owned original into fresh retry", async () => {
    const ports = externalPorts();
    const f = await productResearchFixture(ctx.db, ctx.actor);
    if (!f.association) throw new Error("Synthetic accepted source missing.");
    const originalOrder = acceptedSourceOrder.parse({
      checksum: f.association.checksum,
      extraction: {
        status: "ready",
        candidate: {
          orderId: f.order.orderId,
          orderedAt: "2026-09-01T12:00:00Z",
          merchant: "Example offline seller",
          currency: "USD",
          printedGrandTotal: 24,
          lines: [
            {
              title: "Small Q-17 device",
              amount: 24,
              lineKind: "principal",
              quantity: 1,
            },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
    });
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ originalOrder })
      .where(eq(importSourceOrder.id, f.association.id));
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: f.order.vendorId,
      orderId: null,
      date: "2026-09-01",
    });
    const admission = await startPurchaseValidationResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        purchaseIds: [f.order.id],
        selectedSources: [
          { purchaseId: f.order.id, sourceOrderId: f.association.id },
        ],
      },
      ports.queue,
    );
    const admitted = admission.row;
    const [target] = await tasks(admitted.id);
    if (!target) throw new Error("Synthetic validation task missing.");
    const service = researchServiceFor(ctx.db, ports.environment, admitted.id, {
      observations: { storage: ports.storage },
    });
    expect(await service.researchNext({}, crypto.randomUUID())).toMatchObject({
      status: "working",
      work: { kind: "purchase" },
    });
    const original = await retainResearchObservation(
      ctx.db,
      {
        runId: admitted.id,
        workRef: target.id,
        callId: crypto.randomUUID(),
        kind: "web_page",
        sourceMetadata: { sourceURL: "https://receipt.example.test/q-17" },
        content:
          "<main>Example offline seller. Small Q-17 device. Grand total USD 24.</main>",
      },
      { storage: ports.storage },
    );
    const proposal = researchWorkResolve.parse({
      workRef: target.id,
      status: "partially_verified",
      identity: {
        evidenceIds: [original.evidenceId],
        reasoning: "The selected accepted original supports this acquisition.",
      },
      facts: [
        {
          fieldPath: "statedTotal",
          value: 24,
          evidenceId: original.evidenceId,
          support: {
            observation: "Grand total USD 24.",
            reasoning:
              "The retained receipt states the exact acquisition's total.",
          },
        },
      ],
      detail:
        "Keep validation advisory; the recorded Purchase still needs member review.",
    });
    const callId = crypto.randomUUID();
    let assessments = 0;
    const result = await resolveImportResearch(
      ctx.db,
      { runId: admitted.id, workRef: target.id, callId, proposal },
      {
        readEvidence: ports.readEvidence,
        assess: async () => {
          assessments++;
          return {
            identityVerified: true,
            acceptedFacts: [0],
            acceptedOrders: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            acceptedEmailLinks: [],
            rejected: [],
          };
        },
      },
    );
    expect(result).toMatchObject({
      status: "researched_with_gaps",
      purchaseIds: [],
      proposedFacts: proposal.facts,
    });
    const delivered = await service.researchResolve(proposal, callId);
    expect(delivered).toMatchObject({ status: "done" });
    const settled = await savedRun(admitted.id);
    expect(settled.status).toBe("needs_review");
    const beforeTasks = await tasks(admitted.id);
    const beforeSources = await getDb(ctx.db).select().from(importSourceOrder);
    const beforeClaims = await getDb(ctx.db).select().from(importSourceClaim);
    const beforeMoney = await getDb(ctx.db).select().from(expense);
    const beforeEvidence = await getDb(ctx.db).select().from(runEvidence);
    const beforeReceipts = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .orderBy(asc(runOperation.id));

    await mergePurchases(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [f.order.shortcode] },
      ctx.actor,
    );

    expect.soft(await tasks(admitted.id)).toMatchObject(
      beforeTasks.map(({ updatedAt: _updated, ...task }) => ({
        ...task,
        entityId: keeper.id,
        workKey: f.order.id,
      })),
    );
    expect(await savedRun(admitted.id)).toEqual(settled);
    expect(await getDb(ctx.db).select().from(importSourceOrder)).toMatchObject(
      beforeSources.map(({ updatedAt: _updated, ...source }) => ({
        ...source,
        purchaseId: keeper.id,
      })),
    );
    expect(await getDb(ctx.db).select().from(importSourceClaim)).toEqual(
      beforeClaims,
    );
    expect(await getDb(ctx.db).select().from(expense)).toMatchObject(
      beforeMoney.map(({ updatedAt: _updated, ...line }) => ({
        ...line,
        purchaseId: keeper.id,
      })),
    );
    expect(await getDb(ctx.db).select().from(runEvidence)).toEqual(
      beforeEvidence,
    );
    expect(await service.researchResolve(proposal, callId)).toEqual(delivered);
    expect(assessments).toBe(1);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runOperation)
        .orderBy(asc(runOperation.id)),
    ).toEqual(beforeReceipts);
    await expect(
      resolveOrThrow(ctx.db, "purchase", f.order.shortcode),
    ).rejects.toThrow(/merged|not found|deleted/iu);

    const control = {
      runPublicId: settled.shortcode,
      action: "retry" as const,
    };
    const retry = await controlRun(ctx.db, ctx.actor, control);
    if (!("successorRunId" in retry) || !retry.successorRunId)
      throw new Error("Synthetic validation retry missing.");
    const successor = await savedRun(runEntityId.parse(retry.successorRunId));
    const saved = purchaseValidationResearchRunInput.parse(successor.input);
    expect(saved.purchases).toHaveLength(1);
    expect(saved.purchases[0]).toMatchObject({
      purchaseId: keeper.id,
      selectedSource: {
        sourceOrderId: f.association.id,
        checksum: f.association.checksum,
      },
    });
    expect(saved.purchases[0]?.contextFingerprint).not.toBe(
      purchaseValidationResearchRunInput.parse(settled.input).purchases[0]
        ?.contextFingerprint,
    );
    expect(await tasks(successor.id)).toMatchObject([
      { entityId: keeper.id, workKey: keeper.id, state: "pending" },
    ]);
    expect(
      await researchServiceFor(
        ctx.db,
        ports.environment,
        successor.id,
      ).researchNext({}, crypto.randomUUID()),
    ).toMatchObject({ status: "working", work: { kind: "purchase" } });
    expect(await controlRun(ctx.db, ctx.actor, control)).toMatchObject({
      successorRunId: successor.id,
      created: false,
    });
    expect(await savedRun(admitted.id)).toEqual(settled);
    expect(await getDb(ctx.db).select().from(expense)).toMatchObject(
      beforeMoney.map(({ updatedAt: _updated, ...line }) => ({
        ...line,
        purchaseId: keeper.id,
      })),
    );
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual([]);
  });
});
