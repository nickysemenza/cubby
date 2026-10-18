import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  expense,
  feedback,
  financialTransactionAllocation,
  product,
} from "~/server/db/schema";
import { createProduct } from "~/server/domains/product/repo/crud";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readRecordWorkQueueWith } from "~/server/generic/work-queue/repo/work-queue";
import {
  createInventoryFixture,
  createLocationFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { retrieveConnectionCandidates } from "../repo/connection-candidates";
import {
  publishEntityConnection,
  readEntityConnections,
} from "../repo/entity-connections";

// The shared review boundary must commit a retry-safe receipt, retire both
// endpoint presentations, and remove the same candidate from Work.
describe("connection application through generic Feedback", () => {
  const ctx = withTestDb();
  it("persists the surviving inventory destination in retry receipts", async () => {
    const item = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic stock wrench" }),
      ctx.actor,
    );
    const origin = await createLocationFixture(
      ctx.db,
      { name: "Synthetic origin", type: "room", aliases: [] },
      ctx.actor,
    );
    const destination = await createLocationFixture(
      ctx.db,
      { name: "Synthetic destination", type: "room", aliases: [] },
      ctx.actor,
    );
    const sourceStock = await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: origin.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    const survivor = await createInventoryFixture(
      ctx.db,
      {
        productId: item.id,
        locationId: destination.id,
        amount: { value: 2, unit: "each" },
      },
      ctx.actor,
    );
    const source = {
      entityKind: "inventory" as const,
      entityId: sourceStock.id,
    };
    const proposal = await publishEntityConnection(ctx.db, {
      relation: "inventory-location",
      source,
      target: { entityKind: "location", entityId: destination.id },
      label: "Review placement",
      evidence: {
        reasons: ["Synthetic placement evidence"],
        contradictions: [],
        unknowns: [],
      },
    });
    const input = {
      assessmentId: proposal.review.assessmentId,
      operationId: "synthetic-placement-survivor",
      verdict: "correct" as const,
      intent: "apply" as const,
      expectedFingerprint: proposal.fingerprint,
    };
    const first = await reviewAssessment(ctx.db, kernelCtx(ctx), input);
    expect(first.applicationResult).toEqual({
      source,
      destination: { entityKind: "inventory", entityId: survivor.id },
    });
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), input)).toEqual(
      first,
    );
  });
  it("hides stale candidates from Work before pagination", async () => {
    const item = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic stale wrench" }),
      ctx.actor,
    );
    const source = { entityKind: "product" as const, entityId: item.id };
    const productId = await resolveOrThrow(ctx.db, "product", item.id);
    const line = await createRepoEntity(ctx, "expense", {
      name: "Synthetic stale charge",
      cost: 19,
      trade: "electrical",
    });
    await publishEntityConnection(ctx.db, {
      relation: "product-expense",
      source,
      target: { entityKind: "expense", entityId: line.output.id },
      label: "Review acquisition",
      evidence: {
        reasons: ["Synthetic evidence"],
        contradictions: [],
        unknowns: [],
      },
    });
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic revised evidence" })
      .where(eq(product.id, productId));
    expect(await readEntityConnections(ctx.db, source)).toEqual([]);
    const work = await readRecordWorkQueueWith(
      async () => [],
      ctx.db,
      null,
      item.id,
      false,
      ctx.actor,
    );
    expect(work.items).not.toContainEqual(
      expect.objectContaining({ key: `connection:${productId}` }),
    );
  });

  it("never proposes or overwrites an existing partial settlement allocation", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic wallet",
      identity: { kind: "cash" },
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic tools",
    });
    const prior = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
    });
    const target = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
      statedTotal: 30,
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 100,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-03",
      merchant: "Synthetic tools",
    });
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: transaction.entityId,
      purchaseId: prior.entityId,
      amount: 70,
    });
    const before = await getDb(ctx.db)
      .select()
      .from(financialTransactionAllocation);
    expect(
      (
        await retrieveConnectionCandidates(ctx.db, {
          entityKind: "purchase",
          entityId: target.output.id,
        })
      ).filter(
        (candidate) => candidate.source.entityId === transaction.output.id,
      ),
    ).toEqual([]);
    const proposal = await publishEntityConnection(ctx.db, {
      relation: "transaction-purchase",
      source: {
        entityKind: "financialTransaction",
        entityId: transaction.output.id,
      },
      target: { entityKind: "purchase", entityId: target.output.id },
      label: "Synthetic settlement",
      evidence: {
        reasons: ["Synthetic evidence"],
        contradictions: [],
        unknowns: [],
      },
    });
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: proposal.review.assessmentId,
        operationId: "synthetic-preserve-allocation",
        verdict: "correct",
        intent: "apply",
        expectedFingerprint: proposal.fingerprint,
      }),
    ).rejects.toThrow(/allocat/i);
    expect(
      await getDb(ctx.db).select().from(financialTransactionAllocation),
    ).toEqual(before);
  });
  it("settles the one Assessment through Work and retries without another write", async () => {
    const item = await createProduct(
      ctx.db,
      makeProductInput({ name: "Synthetic review wrench" }),
      ctx.actor,
    );
    const line = await createRepoEntity(ctx, "expense", {
      name: "Synthetic itemized wrench",
      cost: 19,
      trade: "electrical",
    });
    const source = { entityKind: "product" as const, entityId: item.id };
    const productId = await resolveOrThrow(ctx.db, "product", item.id);
    const target = { entityKind: "expense" as const, entityId: line.output.id };
    const proposal = await publishEntityConnection(ctx.db, {
      relation: "product-expense",
      source,
      target,
      label: "This Expense acquired this Product",
      evidence: {
        reasons: ["Synthetic itemized variant evidence"],
        contradictions: [],
        unknowns: [],
      },
    });
    const work = () =>
      readRecordWorkQueueWith(
        async () => [],
        ctx.db,
        null,
        item.id,
        false,
        ctx.actor,
      );
    expect((await work()).items).toContainEqual(
      expect.objectContaining({
        key: `connection:${productId}`,
        source: "suggestion",
      }),
    );
    const input = {
      assessmentId: proposal.review.assessmentId,
      operationId: "synthetic-connection-accept",
      verdict: "correct" as const,
      intent: "apply" as const,
      expectedFingerprint: proposal.fingerprint,
    };
    const first = await reviewAssessment(ctx.db, kernelCtx(ctx), input);
    expect(first.applied).toBe(true);
    expect(await reviewAssessment(ctx.db, kernelCtx(ctx), input)).toEqual(
      first,
    );
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(expense)
          .where(eq(expense.shortcode, target.entityId))
      )[0]?.productId,
    ).toBe(productId);
    expect(await readEntityConnections(ctx.db, target)).toEqual([]);
    expect((await work()).items).not.toContainEqual(
      expect.objectContaining({ key: `connection:${productId}` }),
    );
    const events = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, proposal.review.assessmentId));
    expect(
      events.filter(
        (event) =>
          event.operationId === `command-application:${input.operationId}`,
      ),
    ).toHaveLength(1);
  });
});
