import { assessmentJudgments } from "@cubby/schemas/assessment";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  product,
  entityLink,
  expense,
} from "~/server/db/schema";
import { discoverAcquisitionCandidates } from "~/server/domains/connection/service/acquisition-discovery";
import { confirmPurchaseAcquisition } from "~/server/domains/purchase/repo/purchase-products";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import {
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { refreshSearchDocument } from "~/server/generic/search/repo/search-document";
import { canonicalJson } from "~/server/lib/canonical-json";
import { measureDatabaseTransfer } from "~/server/testing/database-transfer.fixtures";
import { deleteThroughKernel } from "~/server/testing/entity-kernel";
import {
  createProductFixture,
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { captureConnectionBasis } from "./connection-evidence";
import {
  publishEntityConnection,
  prepareEntityConnectionEvidence,
  publishPreparedEntityConnections,
  readEntityConnections,
  applyEntityConnection,
} from "./entity-connections";
import { assertConnectionFieldFresh } from "./field-connections";

// Failure modes: reverse reads miss a candidate; bare Wrong suppresses future
// evidence; stale/deleted endpoints apply; mutation escapes the caller rollback.
describe("stored connection evidence", () => {
  const ctx = withTestDb();
  async function fixture() {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic connection drill" }),
      ctx.actor,
    );
    const charge = await createRepoEntity(ctx, "expense", {
      name: "Synthetic drill charge",
      cost: 18,
      trade: "electrical",
      costType: "tools",
    });
    const candidate = {
      relation: "product-expense" as const,
      source: { entityKind: "product" as const, entityId: item.id },
      target: { entityKind: "expense" as const, entityId: charge.output.id },
      label: "Connect acquisition charge",
      evidence: {
        reasons: ["Member review required"],
        contradictions: [],
        unknowns: ["Product identity is unconfirmed"],
      },
    };
    const proposal = await publishEntityConnection(ctx.db, candidate);
    return { item, charge, candidate, proposal };
  }

  it("keeps the last edge publication active when page owners retrieve different evidence for the same pair", async () => {
    const { candidate, proposal } = await fixture();
    const changed = {
      ...candidate,
      evidence: {
        ...candidate.evidence,
        reasons: ["Synthetic second retrieval"],
      },
    };
    const prepared = await prepareEntityConnectionEvidence(ctx.db, [
      candidate,
      changed,
    ]);
    const [first, last] = await publishPreparedEntityConnections(
      ctx.db,
      prepared,
    );
    expect(first?.review.assessmentId).toBe(proposal.review.assessmentId);
    expect(last).toBeDefined();
    expect(
      (await readEntityConnections(ctx.db, candidate.source)).map(
        (entry) => entry.review.assessmentId,
      ),
    ).toEqual([last?.review.assessmentId]);
  });

  // Stored basis snapshots can dwarf the candidate. Transferring them before
  // queue pagination exhausts Worker memory; freshness must still reread facts.
  it("reads fresh connection candidates without transferring stored basis snapshots", async () => {
    const { candidate, proposal, item } = await fixture();
    const [original] = await getDb(ctx.db)
      .select()
      .from(assessment)
      .where(eq(assessment.id, proposal.review.assessmentId));
    if (!original) throw new Error("Synthetic Assessment is missing");
    const oversized = await publishAssessment(
      ctx.db,
      {
        publicationKey: "synthetic-oversized-connection-basis",
        family: "recommendation",
        subject: original.subject,
        judgment: assessmentJudgments.recommendation.parse(original.judgment),
        producer: null,
        fingerprint: proposal.fingerprint,
        evidence: {
          version: 1,
          candidate,
          basis: { syntheticBallast: "x".repeat(128 * 1024) },
        },
      },
      { data: { connection: true } },
    );
    const measured = await measureDatabaseTransfer(
      ctx.databaseUrl,
      async (db) => {
        const fresh = await readEntityConnections(db, candidate.source);
        expect(fresh.map((entry) => entry.review.assessmentId)).toContain(
          oversized.id,
        );
        await getDb(ctx.db)
          .update(product)
          .set({ name: "Synthetic changed connection evidence" })
          .where(eq(product.id, item.entityId));
        expect(await readEntityConnections(db, candidate.source)).toEqual([]);
        await reviewAssessment(db, kernelCtx({ ...ctx, db }), {
          assessmentId: oversized.id,
          operationId: "synthetic-oversized-history-review",
          verdict: "dismissed",
          intent: "history",
        });
      },
    );
    expect(measured.largestValueBytes).toBeLessThan(64 * 1024);
  });

  // Existing field suggestions share the connection list. Their currentness
  // guard must compare stored JSON in PostgreSQL, not download its full basis.
  it("filters existing field connections without downloading their stored snapshots", async () => {
    const { candidate, charge, item } = await fixture();
    const basis = await captureConnectionBasis(ctx.db, candidate);
    const stored = await publishAssessment(
      ctx.db,
      {
        publicationKey: "synthetic-field-connection-transfer",
        family: "field",
        subject: {
          kind: "field",
          entity: "expense",
          recordId: charge.entityId,
          field: "productId",
        },
        judgment: { value: item.id },
        fingerprint: "synthetic-field-connection-fingerprint",
        producer: null,
        evidence: { syntheticBallast: "x".repeat(128 * 1024) },
      },
      {
        suggestedValue: item.id,
        data: {
          connectionEvidence: { version: 1, candidate, basis },
          syntheticBallast: "x".repeat(128 * 1024),
        },
      },
    );
    const measured = await measureDatabaseTransfer(
      ctx.databaseUrl,
      async (db) => {
        expect(
          (await readEntityConnections(db, candidate.source)).map(
            (row) => row.review.assessmentId,
          ),
        ).toContain(stored.id);
        await withTransactionDatabase(db, (transactionDb) =>
          assertConnectionFieldFresh(transactionDb, stored.id),
        );
        await getDb(ctx.db)
          .update(assessmentState)
          .set({
            data: {
              connectionEvidence: {
                version: 1,
                candidate,
                basis: { syntheticBallast: "x".repeat(128 * 1024) },
              },
            },
          })
          .where(eq(assessmentState.id, stored.id));
        expect(
          (await readEntityConnections(db, candidate.source)).map(
            (row) => row.review.assessmentId,
          ),
        ).not.toContain(stored.id);
        await expect(
          withTransactionDatabase(db, (transactionDb) =>
            assertConnectionFieldFresh(transactionDb, stored.id),
          ),
        ).rejects.toThrow("Connection field evidence changed");
      },
    );
    expect(measured.largestValueBytes).toBeLessThan(64 * 1024);
  });

  it("refuses direct publication for an Expense already assigned to another Product", async () => {
    const { candidate, charge } = await fixture();
    const other = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic prior owner" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(expense)
      .set({ productId: other.entityId })
      .where(eq(expense.id, charge.entityId));
    await expect(publishEntityConnection(ctx.db, candidate)).rejects.toThrow(
      /eligible|already assigned/i,
    );
    expect(
      (
        await getDb(ctx.db)
          .select({ productId: expense.productId })
          .from(expense)
          .where(eq(expense.id, charge.entityId))
      )[0]?.productId,
    ).toBe(other.entityId);
  });

  it("does not let a fresh forged basis authorize replacing an assignment or reconfirming an acquired pair", async () => {
    const { candidate, charge, item, proposal } = await fixture();
    const other = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic protected owner" }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(expense)
      .set({ productId: other.entityId })
      .where(eq(expense.id, charge.entityId));
    const [original] = await getDb(ctx.db)
      .select()
      .from(assessment)
      .where(eq(assessment.id, proposal.review.assessmentId));
    if (!original) throw new Error("Synthetic original Assessment is missing");
    const evidence = {
      version: 1,
      candidate,
      basis: await captureConnectionBasis(ctx.db, candidate),
    };
    const fingerprint = await sha256Hex(canonicalJson(evidence));
    const forged = await publishAssessment(ctx.db, {
      publicationKey: "synthetic-owned-expense-proposal",
      family: "recommendation",
      subject: original.subject,
      judgment: assessmentJudgments.recommendation.parse(original.judgment),
      producer: null,
      evidence,
      fingerprint,
    });
    await expect(
      applyEntityConnection(
        ctx.db,
        kernelCtx(ctx),
        { id: forged.id },
        {
          verdict: "correct",
          expectedFingerprint: fingerprint,
          correction: { present: false },
        },
      ),
    ).rejects.toThrow(/eligible|already assigned/i);
    expect(
      (
        await getDb(ctx.db)
          .select({ productId: expense.productId })
          .from(expense)
          .where(eq(expense.id, charge.entityId))
      )[0]?.productId,
    ).toBe(other.entityId);

    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic acquisition guard shop",
    });
    const order = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-02-01",
      defaultTrade: "electrical",
    });
    const acquisition = {
      ...candidate,
      relation: "product-purchase" as const,
      target: { entityKind: "purchase" as const, entityId: order.output.id },
    };
    const pending = await publishEntityConnection(ctx.db, acquisition);
    await confirmPurchaseAcquisition(ctx.db, {
      productId: item.id,
      purchaseId: order.output.id,
    });
    await expect(publishEntityConnection(ctx.db, acquisition)).rejects.toThrow(
      /eligible|already acquired/i,
    );
    const [purchasePrediction] = await getDb(ctx.db)
      .select()
      .from(assessment)
      .where(eq(assessment.id, pending.review.assessmentId));
    if (!purchasePrediction)
      throw new Error("Synthetic purchase Assessment is missing");
    const confirmedEvidence = {
      version: 1,
      candidate: acquisition,
      basis: await captureConnectionBasis(ctx.db, acquisition),
    };
    const confirmedFingerprint = await sha256Hex(
      canonicalJson(confirmedEvidence),
    );
    const confirmedForgery = await publishAssessment(ctx.db, {
      publicationKey: "synthetic-confirmed-purchase-proposal",
      family: "recommendation",
      subject: purchasePrediction.subject,
      judgment: assessmentJudgments.recommendation.parse(
        purchasePrediction.judgment,
      ),
      producer: null,
      evidence: confirmedEvidence,
      fingerprint: confirmedFingerprint,
    });
    await expect(
      applyEntityConnection(
        ctx.db,
        kernelCtx(ctx),
        { id: confirmedForgery.id },
        {
          verdict: "correct",
          expectedFingerprint: confirmedFingerprint,
          correction: { present: false },
        },
      ),
    ).rejects.toThrow(/eligible|already acquired/i);
  });

  it("does not let stale candidates consume another endpoint's results", async () => {
    const { item, candidate } = await fixture();
    for (let index = 0; index < 30; index++) {
      const charge = await createRepoEntity(ctx, "expense", {
        name: `Synthetic obsolete charge ${index}`,
        cost: 18,
        trade: "electrical",
        costType: "tools",
      });
      await publishEntityConnection(ctx.db, {
        ...candidate,
        target: { entityKind: "expense", entityId: charge.output.id },
      });
    }
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic new evidence" })
      .where(eq(product.id, item.entityId));
    const fresh = await publishEntityConnection(ctx.db, candidate);
    expect(
      (await readEntityConnections(ctx.db, candidate.source)).map(
        (proposal) => proposal.review.assessmentId,
      ),
    ).toEqual([fresh.review.assessmentId]);
    expect(
      (await readEntityConnections(ctx.db, candidate.target)).map(
        (proposal) => proposal.review.assessmentId,
      ),
    ).toEqual([fresh.review.assessmentId]);
  });

  it("reads either endpoint and keeps Wrong event-specific across changed evidence", async () => {
    const { candidate, proposal, item } = await fixture();
    expect(
      (await readEntityConnections(ctx.db, candidate.target)).map(
        (p) => p.review.assessmentId,
      ),
    ).toContain(proposal.review.assessmentId);
    expect(
      (await publishEntityConnection(ctx.db, candidate)).review.assessmentId,
    ).toBe(proposal.review.assessmentId);
    await recordFeedback(ctx.db, {
      assessmentId: proposal.review.assessmentId,
      operationId: "synthetic-wrong",
      verdict: "wrong",
      authority: "member",
      actorUserId: ctx.actor.userId,
    });
    expect(await readEntityConnections(ctx.db, candidate.source)).toEqual([]);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic corrected drill" })
      .where(eq(product.id, item.entityId));
    const changed = await publishEntityConnection(ctx.db, candidate);
    expect(changed.review.assessmentId).not.toBe(proposal.review.assessmentId);
    const [retired] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, proposal.review.assessmentId));
    expect(retired).toMatchObject({ active: false, status: "superseded" });
    expect(
      (await readEntityConnections(ctx.db, candidate.source)).map(
        (p) => p.review.assessmentId,
      ),
    ).toContain(changed.review.assessmentId);
  });

  it("refuses changed endpoints before applying", async () => {
    const { candidate, proposal, item } = await fixture();
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessment)
      .where(eq(assessment.id, proposal.review.assessmentId));
    if (!state) throw new Error("Missing synthetic Assessment");
    await deleteThroughKernel(ctx.db, ctx.actor, "product", [item.id]);
    await expect(
      withTransactionDatabase(ctx.db, async (db) =>
        applyEntityConnection(
          db,
          kernelCtx(ctx),
          { id: state.id },
          {
            verdict: "correct",
            expectedFingerprint: proposal.fingerprint,
            correction: { present: false },
          },
        ),
      ),
    ).rejects.toThrow(/no longer exists|not found/);
    expect(await readEntityConnections(ctx.db, candidate.target)).toEqual([]);
  });
  it("keeps unrelated timestamp edits fresh and rolls back domain writes with its caller", async () => {
    const { candidate, proposal, charge, item } = await fixture();
    await getDb(ctx.db)
      .update(product)
      .set({ updatedAt: new Date() })
      .where(eq(product.id, item.entityId));
    expect(
      (await readEntityConnections(ctx.db, candidate.source)).map(
        (p) => p.review.assessmentId,
      ),
    ).toContain(proposal.review.assessmentId);
    const input = {
      verdict: "correct" as const,
      expectedFingerprint: proposal.fingerprint,
      correction: { present: false as const },
    };
    await expect(
      withTransactionDatabase(ctx.db, async (db) => {
        await applyEntityConnection(
          db,
          kernelCtx(ctx),
          { id: proposal.review.assessmentId },
          input,
        );
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    const [unchanged] = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(eq(expense.shortcode, charge.output.id));
    expect(unchanged?.productId).toBeNull();
    await applyEntityConnection(
      ctx.db,
      kernelCtx(ctx),
      { id: proposal.review.assessmentId },
      input,
    );
    const [changed] = await getDb(ctx.db)
      .select()
      .from(expense)
      .where(eq(expense.shortcode, charge.output.id));
    expect(changed?.productId).toBe(item.entityId);
  });

  it("retrieves an unlinked unitemized Purchase from notes without needing inventory", async () => {
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic cobalt drill" }),
      ctx.actor,
    );
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic hardware shop",
    });
    const order = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-02-01",
      notes: "Synthetic cobalt drill supplied with the workshop order",
      defaultTrade: "electrical",
    });
    await refreshSearchDocument(ctx.db, "purchase", order.entityId);
    const candidates = await discoverAcquisitionCandidates(ctx.db, {
      entityKind: "product",
      entityId: item.id,
    });
    expect(candidates).toContainEqual(
      expect.objectContaining({
        relation: "product-purchase",
        target: { entityKind: "purchase", entityId: order.output.id },
      }),
    );
    expect(await getDb(ctx.db).select().from(entityLink)).toEqual([]);
    const proposed = await publishEntityConnection(
      ctx.db,
      candidates.find((c) => c.target.entityId === order.output.id)!,
    );
    const command = {
      assessmentId: proposed.review.assessmentId,
      operationId: "synthetic-acquisition-accept",
      intent: "apply" as const,
      verdict: "correct" as const,
      expectedFingerprint: proposed.fingerprint,
      correction: { present: false as const },
    };
    const receipt = await reviewAssessment(ctx.db, kernelCtx(ctx), command);
    expect(receipt.applied).toBe(true);
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), command)).toEqual(
      receipt,
    );
    expect(await getDb(ctx.db).select().from(entityLink)).toMatchObject([
      { acquisitionConfirmed: true },
    ]);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });

  it("retains an explicit suppression across evidence changes without reopening unchanged Wrong", async () => {
    const { candidate, proposal, item } = await fixture();
    if (!proposal.review.suppression)
      throw new Error("Expected declared recommendation suppression");
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: proposal.review.assessmentId,
      operationId: "synthetic-suppress",
      verdict: "dismissed",
      intent: "history",
      suppression: proposal.review.suppression,
    });
    expect(await readEntityConnections(ctx.db, candidate.source)).toEqual([]);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic revised tool evidence" })
      .where(eq(product.id, item.entityId));
    await publishEntityConnection(ctx.db, candidate);
    expect(await readEntityConnections(ctx.db, candidate.source)).toEqual([]);
    const [preference] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, proposal.review.assessmentId));
    expect(preference?.active).toBe(true);
  });
});
