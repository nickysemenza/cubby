import { eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransaction } from "~/server/db/helpers";
import { assessment, assessmentState, feedback } from "~/server/db/schema";
import {
  kernelCtx,
  productFixture,
  recordId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import {
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";

import {
  rebuildAssessmentStates,
  retireAssessmentTargetsTx,
  transitionAssessmentState,
} from "./assessment-state";

type Ctx = ReturnType<typeof withTestDb>;

const liveRows = async (ctx: Ctx, ids: readonly string[]) =>
  (
    await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(inArray(assessmentState.id, [...ids]))
      .orderBy(assessmentState.id)
  ).map(({ updatedAt: _updatedAt, ...row }) => row);

/** Drop the current rows and replay them from the ledger alone. */
async function rebuiltRows(ctx: Ctx, ids: readonly string[]) {
  await getDb(ctx.db)
    .delete(assessmentState)
    .where(inArray(assessmentState.id, [...ids]));
  await rebuildAssessmentStates(ctx.db, ids);
  return liveRows(ctx, ids);
}

const recommendation = (productId: string, key: string) => ({
  publicationKey: `synthetic:state-parity:${key}`,
  family: "recommendation" as const,
  subject: {
    kind: "recommendation" as const,
    entity: "product",
    recordId: productId,
    scope: "product.related",
    candidateKey: key,
  },
  judgment: { candidateKey: key },
  fingerprint: `synthetic-${key}`,
  producer: null,
  evidence: null,
});

// Failure modes: a rebuild loses a member's decision, suppression or receipt;
// replays transitions out of order; lets a retired column or an unrelated
// Feedback change the row; creates review state for an evaluation sample;
// or loses an Email link review when its Email is removed.
describe("AssessmentState rebuild", () => {
  const ctx = withTestDb();

  it("replays publication, member review and system transitions exactly", async () => {
    const product = await productFixture(ctx, "Synthetic parity item");
    const productId = await recordId(ctx.db, product.id, "product");
    const kept = await publishAssessment(
      ctx.db,
      recommendation(productId, "kept"),
      { data: { candidateKey: "kept" } },
    );
    const dismissed = await publishAssessment(
      ctx.db,
      recommendation(productId, "dismissed"),
      { data: { candidateKey: "dismissed" } },
    );
    expect(kept.projection).toMatchObject({
      entity: "product",
      recordId: productId,
      fingerprint: "synthetic-kept",
    });
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: dismissed.id,
      operationId: "synthetic-dismissal",
      verdict: "dismissed",
      intent: "history",
      suppression: {
        scope: "product.related",
        candidateKey: "dismissed",
        fingerprint: null,
      },
    });
    // Two transitions in one transaction must replay in statement order.
    await withTransaction(ctx.db, async (tx) => {
      await transitionAssessmentState(
        tx,
        kept.id,
        { confidence: 0.4 },
        { kind: "synthetic" },
      );
      await transitionAssessmentState(
        tx,
        kept.id,
        { confidence: 0.7, acceptanceReceipt: null },
        { kind: "synthetic" },
      );
    });
    // Grades without a patch never move the projection.
    await recordFeedback(ctx.db, {
      assessmentId: kept.id,
      operationId: "synthetic-grade",
      verdict: "correct",
      authority: "evaluation",
      actorUserId: null,
    });
    const ids = [kept.id, dismissed.id];
    const live = await liveRows(ctx, ids);
    expect(live.find((row) => row.id === dismissed.id)?.suppression).toEqual(
      expect.objectContaining({ candidateKey: "dismissed" }),
    );
    expect(live.find((row) => row.id === kept.id)?.confidence).toBe(0.7);
    expect(await rebuiltRows(ctx, ids)).toEqual(live);
    const events = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.authority, "system"));
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(
      events.every(
        (event) =>
          event.actorUserId === null &&
          event.verdict === "ungraded" &&
          event.intent === "projection",
      ),
    ).toBe(true);
  });

  it("rebuilds a legacy row from its migration snapshot and ignores retired columns", async () => {
    const product = await productFixture(ctx, "Synthetic legacy parity item");
    const productId = await recordId(ctx.db, product.id, "product");
    // Shape of a migrated row: no creation snapshot, and one legacy snapshot
    // carrying a column the schema no longer has.
    const [legacy] = await getDb(ctx.db)
      .insert(assessment)
      .values(recommendation(productId, "legacy"))
      .returning();
    const before = {
      id: legacy!.id,
      family: "recommendation" as const,
      entity: "product",
      recordId: productId,
      fingerprint: "synthetic-legacy",
      suggestedValue: { candidateKey: "legacy" },
      status: "resolved",
    };
    await getDb(ctx.db).insert(assessmentState).values(before);
    const [current] = await liveRows(ctx, [legacy!.id]);
    const {
      id: _id,
      family: _family,
      createdAt: _createdAt,
      ...columns
    } = current!;
    await getDb(ctx.db)
      .insert(feedback)
      .values({
        assessmentId: legacy!.id,
        operationId: "legacy-projection",
        verdict: "ungraded",
        correction: { present: false },
        intent: "projection",
        authority: "unknown",
        actorUserId: null,
        projection: JSON.parse(JSON.stringify({ ...columns, pairKey: null })),
      });
    const [rebuilt] = await rebuiltRows(ctx, [legacy!.id]);
    expect(rebuilt).toEqual({ ...current, createdAt: legacy!.createdAt });
  });

  it("keeps an evaluation sample out of review state", async () => {
    const sample = await publishAssessment(ctx.db, {
      publicationKey: "evaluation_sample:email_accuracy:synthetic",
      family: "evaluation_sample",
      subject: {
        kind: "evaluation_sample",
        evaluation: "email_accuracy",
        ownerUserId: ctx.actor.userId,
      },
      judgment: { version: 1, strata: [], items: [] },
      fingerprint: null,
      producer: null,
      evidence: null,
      served: false,
    });
    expect(sample.projection).toBeNull();
    expect(await rebuildAssessmentStates(ctx.db, [sample.id])).toEqual([]);
    expect(await liveRows(ctx, [sample.id])).toEqual([]);
  });

  it("retires a removed record's rows as replayable system events", async () => {
    const product = await productFixture(ctx, "Synthetic removed parity item");
    const productId = await recordId(ctx.db, product.id, "product");
    const published = await publishAssessment(
      ctx.db,
      recommendation(productId, "removed"),
    );
    await withTransaction(ctx.db, (tx) =>
      retireAssessmentTargetsTx(tx, "product", [productId]),
    );
    const [live] = await liveRows(ctx, [published.id]);
    expect(live).toMatchObject({ active: false, status: "superseded" });
    expect(await rebuiltRows(ctx, [published.id])).toEqual([live]);
    // History stays: the Assessment row is untouched.
    expect(
      await getDb(ctx.db)
        .select({ id: assessment.id })
        .from(assessment)
        .where(eq(assessment.id, published.id)),
    ).toEqual([{ id: published.id }]);
  });
});
