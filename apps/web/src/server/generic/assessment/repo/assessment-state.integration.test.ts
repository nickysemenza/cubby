import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import * as queryTelemetry from "~/server/db/db-query-telemetry";
import { getDb, withTransaction } from "~/server/db/helpers";
import { updateManyAndReturn } from "~/server/db/helpers/crud";
import { assessment, assessmentState, feedback } from "~/server/db/schema";
import {
  kernelCtx,
  productFixture,
  recordId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import {
  publishAssessment,
  publishAssessments,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";

import {
  rebuildAssessmentStates,
  retireAssessmentTargetsTx,
  transitionAssessmentState,
  transitionAssessmentStates,
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

  it("publishes batches in input order with singleton-equivalent snapshots and JSON nulls", async () => {
    const product = await productFixture(ctx, "Synthetic bulk parity item");
    const productId = await recordId(ctx.db, product.id, "product");
    const input = recommendation(productId, "bulk-parity");
    const projection = {
      suggestedValue: null,
      data: { candidateKey: "bulk-parity" },
    };
    const singleton = await publishAssessment(ctx.db, input, projection);
    const fresh = { ...input, publicationKey: `${input.publicationKey}:batch` };
    const image = {
      publicationKey: "synthetic:batch:null-image-judgment",
      family: "image_description" as const,
      subject: {
        kind: "image_description" as const,
        entity: "image" as const,
        recordId: crypto.randomUUID(),
        contentHash: null,
      },
      judgment: null,
      fingerprint: null,
      producer: null,
      evidence: null,
    };
    const sample = {
      publicationKey: "synthetic:batch:evaluation-sample",
      family: "evaluation_sample" as const,
      subject: {
        kind: "evaluation_sample" as const,
        evaluation: "email_accuracy" as const,
        ownerUserId: ctx.actor.userId,
      },
      judgment: { version: 1 as const, strata: [], items: [] },
      fingerprint: null,
      producer: null,
      evidence: null,
      served: false,
    };
    const entries = [
      { input: fresh, projection },
      { input, projection: { suggestedValue: "ignored replay projection" } },
      { input: image },
      {
        input: fresh,
        projection: { suggestedValue: "ignored duplicate projection" },
      },
      { input: sample },
    ];
    const rows = await publishAssessments(ctx.db, entries);
    expect(rows.map((row) => row.publicationKey)).toEqual(
      entries.map((entry) => entry.input.publicationKey),
    );
    const [batched, replayed, nullImage, duplicate, evaluation] = rows;
    expect(replayed).toEqual(singleton);
    expect(duplicate).toEqual(batched);
    expect(batched?.projection).toEqual(singleton.projection);
    expect(nullImage?.judgment).toBeNull();
    expect(nullImage?.projection).toMatchObject({ suggestedValue: null });
    expect(evaluation?.projection).toBeNull();
    const ids = rows.map((row) => row.id);
    const states = await liveRows(ctx, ids);
    expect(states).toHaveLength(3);
    expect(states.every((state) => state.suggestedValue === null)).toBe(true);
    expect(await rebuiltRows(ctx, ids)).toEqual(states);
    expect(await publishAssessments(ctx.db, entries)).toEqual(rows);
    expect(await liveRows(ctx, ids)).toEqual(states);
    expect(await publishAssessments(ctx.db, [])).toEqual([]);
  });

  it("rolls back new batch publications when an existing key changes immutable evidence", async () => {
    const product = await productFixture(ctx, "Synthetic bulk conflict item");
    const productId = await recordId(ctx.db, product.id, "product");
    const input = recommendation(productId, "existing-bulk-conflict");
    const existing = await publishAssessment(ctx.db, input);
    const fresh = recommendation(productId, "rolled-back-bulk-publication");
    const before = await liveRows(ctx, [existing.id]);
    await expect(
      publishAssessments(ctx.db, [
        { input: fresh },
        { input: { ...input, evidence: { changed: true } } },
      ]),
    ).rejects.toThrow(
      "Assessment publication retry changed immutable evidence",
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessment)
        .where(eq(assessment.publicationKey, fresh.publicationKey)),
    ).toEqual([]);
    expect(await liveRows(ctx, [existing.id])).toEqual(before);
  });

  it("rejects conflicting duplicate publication keys without retaining other batch rows", async () => {
    const product = await productFixture(
      ctx,
      "Synthetic duplicate conflict item",
    );
    const productId = await recordId(ctx.db, product.id, "product");
    const duplicate = recommendation(productId, "conflicting-bulk-duplicate");
    const other = recommendation(productId, "duplicate-bulk-bystander");
    await expect(
      publishAssessments(ctx.db, [
        { input: other },
        { input: duplicate },
        { input: { ...duplicate, judgment: { candidateKey: "changed" } } },
      ]),
    ).rejects.toThrow(
      "Assessment publication retry changed immutable evidence",
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessment)
        .where(
          inArray(assessment.publicationKey, [
            duplicate.publicationKey,
            other.publicationKey,
          ]),
        ),
    ).toEqual([]);
  });

  it("validates every batch judgment and projection before publishing any rows", async () => {
    const product = await productFixture(ctx, "Synthetic invalid batch item");
    const productId = await recordId(ctx.db, product.id, "product");
    const valid = recommendation(productId, "valid-before-invalid-bulk");
    const invalid = recommendation(productId, "invalid-bulk");
    await expect(
      publishAssessments(ctx.db, [
        { input: valid },
        { input: { ...invalid, judgment: null } },
      ]),
    ).rejects.toThrow(/expected object/);
    await expect(
      publishAssessments(ctx.db, [
        { input: valid },
        { input: invalid, projection: { recordId: "invalid-target" } },
      ]),
    ).rejects.toThrow(/Invalid UUID/);
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessment)
        .where(
          inArray(assessment.publicationKey, [
            valid.publicationKey,
            invalid.publicationKey,
          ]),
        ),
    ).toEqual([]);
  });

  it("preserves reviewed and absent projection states when a batch replays existing publications", async () => {
    const product = await productFixture(ctx, "Synthetic bulk replay item");
    const productId = await recordId(ctx.db, product.id, "product");
    const reviewedInput = recommendation(productId, "bulk-reviewed");
    const absentInput = recommendation(productId, "bulk-absent");
    const [reviewed, absent] = await publishAssessments(ctx.db, [
      { input: reviewedInput },
      { input: absentInput },
    ]);
    await withTransaction(ctx.db, (tx) =>
      transitionAssessmentState(
        tx,
        reviewed!.id,
        {
          status: "resolved",
          confidence: 0.7,
          confirmedValue: { present: true, value: "retained" },
        },
        { kind: "synthetic-batch-review" },
      ),
    );
    // A publication retry cannot repair a missing projection implicitly.
    await getDb(ctx.db)
      .delete(assessmentState)
      .where(eq(assessmentState.id, absent!.id));
    const ids = [reviewed!.id, absent!.id];
    const before = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(inArray(assessmentState.id, ids));
    const fresh = recommendation(productId, "bulk-with-replays");
    const rows = await publishAssessments(ctx.db, [
      {
        input: absentInput,
        projection: { suggestedValue: "must not recreate" },
      },
      { input: fresh },
      {
        input: reviewedInput,
        projection: { suggestedValue: "must not overwrite", status: "pending" },
      },
    ]);
    expect(rows[0]).toEqual(absent);
    expect(rows[2]).toEqual(reviewed);
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(inArray(assessmentState.id, ids)),
    ).toEqual(before);
    expect(
      await liveRows(
        ctx,
        rows.map((row) => row.id),
      ),
    ).toHaveLength(2);
  });

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

  it("batches distinct projection values while preserving replay, no-ops and rollback", async () => {
    const product = await productFixture(
      ctx,
      "Synthetic heterogeneous transitions",
    );
    const productId = await recordId(ctx.db, product.id, "product");
    const publications = await publishAssessments(
      ctx.db,
      Array.from({ length: 260 }, (_, index) => ({
        input: recommendation(productId, `bulk-${index}`),
        projection: {
          data: { retained: index },
          fingerprint: `before-${index}`,
        },
      })),
    );
    const ids = publications.map((row) => row.id);
    const returning: string[] = [];
    const statementForTrace = queryTelemetry.databaseStatementForTrace;
    // Observe the actual driver SQL before telemetry truncates large CASE batches.
    const trace = vi
      .spyOn(queryTelemetry, "databaseStatementForTrace")
      .mockImplementation((head) => {
        const text = typeof head === "string" ? head : head.text;
        if (text.startsWith('update "AssessmentState"'))
          returning.push(text.split(" returning ")[1] ?? "");
        return statementForTrace(head);
      });
    await withTransaction(ctx.db, async (tx) => {
      const changed = await transitionAssessmentStates(
        tx,
        inArray(assessmentState.id, ids),
        (row) => ({
          data: { retained: row.data, completed: row.id },
          suggestedValue: null,
          fingerprint: null,
          confidence: undefined,
        }),
        { kind: "synthetic_bulk" },
      );
      expect(changed.map((row) => row.id)).toEqual([...ids].sort());
      expect(changed).toEqual(
        [...ids].sort().map((id) => ({
          id,
          entity: "product",
          active: true,
          status: "pending",
        })),
      );
    }).finally(() => trace.mockRestore());
    expect(returning.length).toBeGreaterThan(1);
    expect(
      returning.every(
        (columns) => columns === '"id", "entity", "active", "status"',
      ),
    ).toBe(true);
    const live = await liveRows(ctx, ids);
    const events = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(inArray(feedback.assessmentId, ids));
    expect(events).toHaveLength(ids.length);
    for (const event of events) {
      expect(event.projection).toMatchObject({
        fingerprint: null,
        suggestedValue: null,
      });
      expect(event.projection).not.toHaveProperty("confidence");
    }
    await withTransaction(ctx.db, async (tx) => {
      expect(
        await transitionAssessmentStates(
          tx,
          inArray(assessmentState.id, ids),
          (row) => ({ data: row.data }),
          { kind: "synthetic_noop" },
        ),
      ).toEqual([]);
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(inArray(feedback.assessmentId, ids)),
    ).toEqual(events);
    await expect(
      withTransaction(ctx.db, async (tx) => {
        await transitionAssessmentStates(
          tx,
          inArray(assessmentState.id, ids),
          (row) => ({ data: { abandoned: row.id } }),
          { kind: "synthetic_abandoned" },
        );
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await liveRows(ctx, ids)).toEqual(live);
    expect(
      await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(inArray(feedback.assessmentId, ids)),
    ).toEqual(events);
    expect(await rebuiltRows(ctx, ids)).toEqual(live);
  });

  it("decodes an explicit native update projection without returning evidence payloads", async () => {
    const product = await productFixture(ctx, "Synthetic native projection");
    const productId = await recordId(ctx.db, product.id, "product");
    const published = await publishAssessment(
      ctx.db,
      recommendation(productId, "native-projection"),
      { data: { retained: "synthetic evidence" }, fingerprint: "before" },
    );
    const changed = await withTransaction(ctx.db, (tx) =>
      updateManyAndReturn(tx, assessmentState, {
        key: "id",
        returning: [
          "id",
          "updatedAt",
          "fingerprint",
          "suggestedValue",
          "confidence",
        ],
        changes: [
          {
            keyValue: published.id,
            patch: {
              fingerprint: null,
              suggestedValue: sql`'null'::jsonb`,
              confidence: undefined,
            },
          },
        ],
      }),
    );
    expect(changed).toEqual([
      {
        id: published.id,
        updatedAt: expect.any(Date),
        fingerprint: null,
        suggestedValue: null,
        confidence: 0,
      },
    ]);
    expect(await liveRows(ctx, [published.id])).toMatchObject([
      { data: { retained: "synthetic evidence" }, suggestedValue: null },
    ]);
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
