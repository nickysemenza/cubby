import { eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import * as queryTelemetry from "~/server/db/db-query-telemetry";
import { getDb, withTransaction } from "~/server/db/helpers";
import { updateManyAndReturn } from "~/server/db/helpers/crud";
import { suggestionTable } from "~/server/db/schema";
import {
  kernelCtx,
  productFixture,
  recordId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import { recordFeedback } from "~/server/generic/suggestions/repo/suggestion";
import {
  publishExactSuggestion,
  publishExactSuggestions,
} from "~/server/generic/suggestions/repo/suggestion-publication";
import { readSuggestionDecisions } from "~/server/testing/suggestion-decisions.fixtures";

import {
  retireSuggestionTargetsTx,
  transitionSuggestionState,
  transitionSuggestionStates,
} from "./suggestion-state";

type Ctx = ReturnType<typeof withTestDb>;

const liveRows = async (ctx: Ctx, ids: readonly string[]) =>
  (
    await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(inArray(suggestionTable.id, [...ids]))
      .orderBy(suggestionTable.id)
  ).map(({ updatedAt: _updatedAt, ...row }) => row);

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

// Failure modes: a transition loses a member's decision or suppression, applies
// out of order, or lets an unrelated Feedback change the row; a publication
// retry overwrites a reviewed row.
describe("Suggestion publication and transitions", () => {
  const ctx = withTestDb();

  it("publishes batches in input order with singleton-equivalent snapshots and JSON nulls", async () => {
    const product = await productFixture(ctx, "Synthetic bulk parity item");
    const productId = await recordId(ctx.db, product.id, "product");
    const input = recommendation(productId, "bulk-parity");
    const projection = {
      suggestedValue: null,
      data: { candidateKey: "bulk-parity" },
    };
    const singleton = await publishExactSuggestion(ctx.db, input, projection);
    const fresh = { ...input, publicationKey: `${input.publicationKey}:batch` };
    const nullProjection = recommendation(productId, "null-projection");
    const entries = [
      { input: fresh, projection },
      { input, projection: { suggestedValue: "ignored replay projection" } },
      { input: nullProjection, projection: { suggestedValue: null } },
      {
        input: fresh,
        projection: { suggestedValue: "ignored duplicate projection" },
      },
    ];
    const rows = await publishExactSuggestions(ctx.db, entries);
    expect(rows.map((row) => row.publicationKey)).toEqual(
      entries.map((entry) => entry.input.publicationKey),
    );
    const [batched, replayed, projectionRow, duplicate] = rows;
    expect(replayed).toEqual(singleton);
    expect(duplicate).toEqual(batched);
    expect(projectionRow?.judgment).toEqual({
      candidateKey: "null-projection",
    });
    expect(projectionRow?.suggestedValue).toBeNull();
    const ids = rows.map((row) => row.id);
    const states = await liveRows(ctx, ids);
    expect(states).toHaveLength(3);
    expect(states.every((state) => state.suggestedValue === null)).toBe(true);
    expect(await publishExactSuggestions(ctx.db, entries)).toEqual(rows);
    expect(await liveRows(ctx, ids)).toEqual(states);
    expect(await publishExactSuggestions(ctx.db, [])).toEqual([]);
  });

  it("rolls back new batch publications when an existing key changes immutable evidence", async () => {
    const product = await productFixture(ctx, "Synthetic bulk conflict item");
    const productId = await recordId(ctx.db, product.id, "product");
    const input = recommendation(productId, "existing-bulk-conflict");
    const existing = await publishExactSuggestion(ctx.db, input);
    const fresh = recommendation(productId, "rolled-back-bulk-publication");
    const before = await liveRows(ctx, [existing.id]);
    await expect(
      publishExactSuggestions(ctx.db, [
        { input: fresh },
        { input: { ...input, evidence: { changed: true } } },
      ]),
    ).rejects.toThrow(
      "Suggestion publication retry changed immutable evidence",
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(eq(suggestionTable.publicationKey, fresh.publicationKey)),
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
      publishExactSuggestions(ctx.db, [
        { input: other },
        { input: duplicate },
        { input: { ...duplicate, judgment: { candidateKey: "changed" } } },
      ]),
    ).rejects.toThrow(
      "Suggestion publication retry changed immutable evidence",
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(
          inArray(suggestionTable.publicationKey, [
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
      publishExactSuggestions(ctx.db, [
        { input: valid },
        { input: { ...invalid, judgment: null } },
      ]),
    ).rejects.toThrow(/expected object/);
    await expect(
      publishExactSuggestions(ctx.db, [
        { input: valid },
        { input: invalid, projection: { recordId: "invalid-target" } },
      ]),
    ).rejects.toThrow(/Invalid UUID/);
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(
          inArray(suggestionTable.publicationKey, [
            valid.publicationKey,
            invalid.publicationKey,
          ]),
        ),
    ).toEqual([]);
  });

  it("preserves a reviewed row when a batch replays its publication", async () => {
    const product = await productFixture(ctx, "Synthetic bulk replay item");
    const productId = await recordId(ctx.db, product.id, "product");
    const reviewedInput = recommendation(productId, "bulk-reviewed");
    const [reviewed] = await publishExactSuggestions(ctx.db, [
      { input: reviewedInput },
    ]);
    await withTransaction(ctx.db, (tx) =>
      transitionSuggestionState(tx, reviewed!.id, {
        status: "resolved",
        confidence: 0.7,
        confirmedValue: { present: true, value: "retained" },
      }),
    );
    const ids = [reviewed!.id];
    const before = await getDb(ctx.db)
      .select()
      .from(suggestionTable)
      .where(inArray(suggestionTable.id, ids));
    const fresh = recommendation(productId, "bulk-with-replays");
    const rows = await publishExactSuggestions(ctx.db, [
      { input: fresh },
      {
        input: reviewedInput,
        projection: { suggestedValue: "must not overwrite", status: "pending" },
      },
    ]);
    expect(rows[1]).toEqual(before[0]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestionTable)
        .where(inArray(suggestionTable.id, ids)),
    ).toEqual(before);
  });

  it("applies publication, member review and system transitions in statement order", async () => {
    const product = await productFixture(ctx, "Synthetic parity item");
    const productId = await recordId(ctx.db, product.id, "product");
    const kept = await publishExactSuggestion(
      ctx.db,
      recommendation(productId, "kept"),
      { data: { candidateKey: "kept" } },
    );
    const dismissed = await publishExactSuggestion(
      ctx.db,
      recommendation(productId, "dismissed"),
      { data: { candidateKey: "dismissed" } },
    );
    expect(kept).toMatchObject({
      entity: "product",
      recordId: productId,
      fingerprint: "synthetic-kept",
    });
    await reviewSuggestion(ctx.db, kernelCtx(ctx), {
      suggestionId: dismissed.id,
      operationId: "synthetic-dismissal",
      verdict: "dismissed",
      intent: "history",
      suppression: {
        scope: "product.related",
        candidateKey: "dismissed",
        fingerprint: null,
      },
    });
    // Two transitions in one transaction must apply in statement order.
    await withTransaction(ctx.db, async (tx) => {
      await transitionSuggestionState(tx, kept.id, { confidence: 0.4 });
      await transitionSuggestionState(tx, kept.id, {
        confidence: 0.7,
        acceptanceReceipt: null,
      });
    });
    // Grades without a patch never move the projection.
    await recordFeedback(ctx.db, {
      suggestionId: kept.id,
      operationId: "synthetic-grade",
      verdict: "correct",
      authority: "member",
      actorUserId: "synthetic-reviewer",
    });
    const ids = [kept.id, dismissed.id];
    const live = await liveRows(ctx, ids);
    expect(live.find((row) => row.id === dismissed.id)?.suppression).toEqual(
      expect.objectContaining({ candidateKey: "dismissed" }),
    );
    expect(live.find((row) => row.id === kept.id)?.confidence).toBe(0.7);
    // Transitions leave no event of their own; only the grade is retained.
    expect(
      (await readSuggestionDecisions(ctx.db, kept.id)).map(
        (decision) => decision.operationId,
      ),
    ).toEqual(["synthetic-grade"]);
  });

  it("batches distinct values while preserving no-ops and rollback", async () => {
    const product = await productFixture(
      ctx,
      "Synthetic heterogeneous transitions",
    );
    const productId = await recordId(ctx.db, product.id, "product");
    const publications = await publishExactSuggestions(
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
        if (text.startsWith('update "Suggestion"'))
          returning.push(text.split(" returning ")[1] ?? "");
        return statementForTrace(head);
      });
    await withTransaction(ctx.db, async (tx) => {
      const changed = await transitionSuggestionStates(
        tx,
        inArray(suggestionTable.id, ids),
        (row) => ({
          data: { retained: row.data, completed: row.id },
          suggestedValue: null,
          fingerprint: null,
          confidence: undefined,
        }),
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
    await withTransaction(ctx.db, async (tx) => {
      expect(
        await transitionSuggestionStates(
          tx,
          inArray(suggestionTable.id, ids),
          (row) => ({ data: row.data }),
        ),
      ).toEqual([]);
    });
    await expect(
      withTransaction(ctx.db, async (tx) => {
        await transitionSuggestionStates(
          tx,
          inArray(suggestionTable.id, ids),
          (row) => ({ data: { abandoned: row.id } }),
        );
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await liveRows(ctx, ids)).toEqual(live);
  });

  it("decodes an explicit native update projection without returning evidence payloads", async () => {
    const product = await productFixture(ctx, "Synthetic native projection");
    const productId = await recordId(ctx.db, product.id, "product");
    const published = await publishExactSuggestion(
      ctx.db,
      recommendation(productId, "native-projection"),
      { data: { retained: "synthetic evidence" }, fingerprint: "before" },
    );
    const changed = await withTransaction(ctx.db, (tx) =>
      updateManyAndReturn(tx, suggestionTable, {
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

  it("retires a removed record's rows", async () => {
    const product = await productFixture(ctx, "Synthetic removed parity item");
    const productId = await recordId(ctx.db, product.id, "product");
    const published = await publishExactSuggestion(
      ctx.db,
      recommendation(productId, "removed"),
    );
    await withTransaction(ctx.db, (tx) =>
      retireSuggestionTargetsTx(tx, "product", [productId]),
    );
    const [live] = await liveRows(ctx, [published.id]);
    expect(live).toMatchObject({ active: false, status: "superseded" });
    // History stays: the Suggestion row is untouched.
    expect(
      await getDb(ctx.db)
        .select({ id: suggestionTable.id })
        .from(suggestionTable)
        .where(eq(suggestionTable.id, published.id)),
    ).toEqual([{ id: published.id }]);
  });
});
