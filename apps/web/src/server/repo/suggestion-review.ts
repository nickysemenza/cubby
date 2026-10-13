import {
  fieldSuggestionsInput,
  financeCategoryApplyInput,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionReviewBatchInput,
  suggestionReviewListInput,
  suggestionStatus,
  type SuggestionReviewBatchOut,
} from "@cubby/schemas/ai";
import { SUGGESTION_AUTO_APPLY_THRESHOLD } from "@cubby/schemas/ai-evaluation";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import { entityRefKey } from "@cubby/schemas/entity";
import type { RunId } from "@cubby/schemas/identifiers";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { suggestionSweepRunInput } from "@cubby/schemas/run-fields";
import { getErrorMessage } from "@cubby/shared";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  run as runTable,
  suggestion as suggestionTable,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { withAuditReceipts } from "~/server/repo/audit-receipts";
import { getDb, withTransactionDatabase } from "~/server/repo/database-helpers";
import { spendingClassificationRevision } from "~/server/repo/expense-category-resolution";
import { applyFinanceCategorySuggestion } from "~/server/repo/finance-suggestion-context";
import { SHORTCODE_TABLE } from "~/server/repo/generated/shortcode-tables.gen";
import {
  lookupShortcodes,
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";

const rowIdInput = z.object({ id: z.string().uuid() });
const jsonSchema = z.json();
const suggestionRowSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  entity: fieldSuggestionsInput.shape.entity,
  recordId: z.string().uuid(),
  field: z.string(),
  financeReviewFingerprint: z.string().nullable(),
  currentValue: jsonSchema.nullable(),
  suggestedValue: jsonSchema,
  confidence: z.number(),
  runnerUpValue: jsonSchema.nullable(),
  runnerUpConfidence: z.number().nullable(),
  model: z.string(),
  kind: z.enum(["correction", "addition"]),
  status: suggestionStatus,
  correctValue: jsonSchema.nullable(),
  pairKey: z.string().uuid().nullable(),
  createdAt: z.date().transform((value) => value.toISOString()),
});

const runDecisionModel = (runInput: unknown) =>
  z
    .object({ decisionModel: z.string().optional() })
    .passthrough()
    .safeParse(runInput).data?.decisionModel;

/** A paired trial row is reviewable only when it is the model its Run
 * served; public rows name their Run by shortcode. */
function reviewableRow(
  suggestion: typeof suggestionTable.$inferSelect,
  runInput: unknown,
  runCode: string,
) {
  return !suggestion.pairKey || runDecisionModel(runInput) === suggestion.model
    ? [{ ...suggestionRowSchema.parse(suggestion), runId: runCode }]
    : [];
}

/** Paired trial rows count only for the model their Run served (the
 * `reviewableRow` rule in SQL). */
export const reviewableSuggestionSql = sql`(${suggestionTable.pairKey} IS NULL OR ${suggestionTable.model} = ${runTable.input}->>'decisionModel')`;

/** Pending review queue, or reviewed history by `status` (the label set a
 * decision eval replays). Every filter composes, including a list page's
 * `recordIds` and `fields`. Paired evaluation candidates never appear. */
export async function listSuggestions(
  db: Database,
  rawInput: z.input<typeof suggestionReviewListInput> = {},
) {
  const input = suggestionReviewListInput.parse(rawInput);
  if (
    (input.recordIds && !input.recordIds.length) ||
    (input.fields && !input.fields.length)
  )
    return [];
  let recordUuids: string[] | undefined;
  if (input.recordIds) {
    if (!input.entity)
      throw new Error(
        "recordIds filters one entity's records; name its entity.",
      );
    recordUuids = [
      ...new Set(
        (
          await resolveLiveShortcodes(db, input.recordIds, input.entity)
        ).values(),
      ),
    ];
    if (!recordUuids.length) return [];
  }
  const conditions = [
    eq(suggestionTable.status, input.status),
    gte(suggestionTable.confidence, input.minConfidence),
  ];
  if (input.entity) conditions.push(eq(suggestionTable.entity, input.entity));
  if (input.field) conditions.push(eq(suggestionTable.field, input.field));
  if (input.kind) conditions.push(eq(suggestionTable.kind, input.kind));
  if (input.runId) conditions.push(eq(runTable.shortcode, input.runId));
  if (recordUuids)
    conditions.push(inArray(suggestionTable.recordId, recordUuids));
  if (input.fields)
    conditions.push(inArray(suggestionTable.field, input.fields));
  // Before the limit: unserved trial candidates must not use up the page.
  conditions.push(reviewableSuggestionSql);
  const rows = await getDb(db)
    .select({
      suggestion: suggestionTable,
      runInput: runTable.input,
      runCode: runTable.shortcode,
    })
    .from(suggestionTable)
    .innerJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(and(...conditions))
    .orderBy(
      input.status === "pending"
        ? desc(suggestionTable.confidence)
        : desc(suggestionTable.updatedAt),
      suggestionTable.id,
    )
    .limit(input.limit);
  const reviewable = rows.flatMap(({ suggestion, runInput, runCode }) =>
    reviewableRow(suggestion, runInput, runCode),
  );
  // Stored rows key records by uuid; the public queue names them by shortcode.
  const refs = reviewable.map((row) =>
    parseEntityRef(row.entity, row.recordId),
  );
  const receiptRunRefs = rows.flatMap(({ suggestion: row }) =>
    row.acceptanceReceipt?.runId
      ? [parseEntityRef("run", row.acceptanceReceipt.runId)]
      : [],
  );
  const codes = await lookupShortcodes(db, [...refs, ...receiptRunRefs]);
  return reviewable.flatMap((row, index) => {
    const ref = refs[index];
    const recordId = ref && codes.get(entityRefKey(ref.entity, ref.id));
    const stored = rows.find(
      (item) => item.suggestion.id === row.id,
    )?.suggestion;
    const receipt = stored?.acceptanceReceipt;
    const acceptanceReceipt = receipt
      ? {
          ...receipt,
          runId: receipt.runId
            ? (codes.get(entityRefKey("run", receipt.runId)) ?? null)
            : null,
        }
      : null;
    const supersessionReceipt = stored?.supersessionReceipt
      ? {
          reason: stored.supersessionReceipt.reason,
          at: stored.supersessionReceipt.at,
        }
      : null;
    return recordId
      ? [
          {
            ...row,
            recordId,
            provenance: stored?.provenance ?? null,
            acceptanceReceipt,
            supersessionReceipt,
          },
        ]
      : [];
  });
}

/** Outcome counts per (entity, field), optionally for one Run. */
export async function suggestionCounts(
  db: Database,
  input: z.input<typeof suggestionCountsInput> = {},
) {
  const { runId } = suggestionCountsInput.parse(input);
  const count = (status: z.infer<typeof suggestionStatus>) =>
    sql<number>`count(*) FILTER (WHERE ${suggestionTable.status} = ${status})::int`;
  const rows = await getDb(db)
    .select({
      entity: suggestionTable.entity,
      field: suggestionTable.field,
      pending: count(suggestionStatus.enum.pending),
      applied: count(suggestionStatus.enum.applied),
      rejected: count(suggestionStatus.enum.rejected),
      superseded: count(suggestionStatus.enum.superseded),
    })
    .from(suggestionTable)
    .innerJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(
      and(
        reviewableSuggestionSql,
        runId ? eq(runTable.shortcode, runId) : undefined,
      ),
    )
    .groupBy(suggestionTable.entity, suggestionTable.field)
    .orderBy(suggestionTable.entity, suggestionTable.field);
  return suggestionCountsOut.parse(rows);
}

async function writeSuggestionValue(
  db: Database,
  context: EntityKernelContext,
  row: Pick<
    z.infer<typeof suggestionRowSchema>,
    "entity" | "recordId" | "field" | "financeReviewFingerprint"
  >,
  value: unknown,
) {
  const typedValue = z.json().parse(value);
  const entity = fieldSuggestionsInput.shape.entity.parse(row.entity);
  const table = SHORTCODE_TABLE[entity];
  const [record] = await getDb(db)
    .select({ shortcode: table.shortcode })
    .from(table)
    .where(eq(table.id, row.recordId))
    .limit(1);
  if (!record) throw new Error(`Suggestion record not found: ${row.recordId}`);
  const reviewedField =
    ((entity === "expense" || entity === "purchase") &&
      row.field === "spendingCategoryId") ||
    (entity === "vendor" &&
      (row.field === "defaultSpendingCategoryId" ||
        row.field === "spendingProfile"));
  if (reviewedField) {
    if (!row.financeReviewFingerprint)
      throw new Error(
        "Suggestion is missing its finance review fingerprint; request a fresh suggestion.",
      );
    const financeField = z
      .enum([
        "spendingCategoryId",
        "defaultSpendingCategoryId",
        "spendingProfile",
      ])
      .parse(row.field);
    const financeInput = financeCategoryApplyInput.parse({
      entity,
      entityId: record.shortcode,
      fingerprint: row.financeReviewFingerprint,
      field: financeField,
      ...(financeField === "spendingCategoryId"
        ? { spendingCategoryId: typedValue }
        : financeField === "defaultSpendingCategoryId"
          ? { defaultSpendingCategoryId: typedValue }
          : { spendingProfile: typedValue }),
    });
    await applyFinanceCategorySuggestion(context, financeInput);
    return;
  }
  await executeEntity(
    context,
    entityCommandSchema.parse({
      action: "update",
      entity,
      id: record.shortcode,
      data: { [row.field]: typedValue },
    }),
  );
}

async function applySuggestionValue(
  db: Database,
  context: EntityKernelContext,
  row: Parameters<typeof writeSuggestionValue>[2],
  value: unknown,
  options: {
    mode?: "automatic" | "member";
    reason?: "confident_addition" | "member_acceptance" | "member_correction";
    confidence?: number;
  } = {},
) {
  const suppliedValue = z.json().parse(value);
  const { auditIds } = await withAuditReceipts(() =>
    writeSuggestionValue(db, context, row, suppliedValue),
  );
  return suggestionAcceptanceReceipt.parse({
    mode: options.mode ?? "member",
    runId: context.actorContext.runId,
    auditIds,
    acceptedAt: new Date().toISOString(),
    reason: options.reason ?? "member_acceptance",
    confidence: options.confidence ?? null,
    threshold:
      options.mode === "automatic" ? SUGGESTION_AUTO_APPLY_THRESHOLD : null,
  });
}

export async function acceptSuggestion(
  db: Database,
  context: EntityKernelContext,
  input: z.infer<typeof rowIdInput>,
  automatic?: { mode: "automatic"; confidence: number },
) {
  const { id } = rowIdInput.parse(input);
  return withTransactionDatabase(db, async (transactionDb) => {
    const [row] = await getDb(transactionDb)
      .select()
      .from(suggestionTable)
      .where(
        and(eq(suggestionTable.id, id), eq(suggestionTable.status, "pending")),
      )
      .limit(1)
      .for("update");
    if (!row) throw new Error(`Pending Suggestion not found: ${id}`);
    const parsed = suggestionRowSchema.parse(row);
    // The shared write path excludes this row by status while superseding its
    // pending siblings. A failed application rolls the status transition back.
    await getDb(transactionDb)
      .update(suggestionTable)
      .set({ status: "applied" })
      .where(eq(suggestionTable.id, id));
    const receipt = await applySuggestionValue(
      transactionDb,
      { ...context, db: transactionDb },
      parsed,
      row.suggestedValue,
      automatic ? { ...automatic, reason: "confident_addition" } : {},
    );
    await getDb(transactionDb)
      .update(suggestionTable)
      .set({ acceptanceReceipt: receipt })
      .where(eq(suggestionTable.id, id));
    return { id, status: "applied" as const };
  });
}

export async function acceptSuggestions(
  db: Database,
  context: EntityKernelContext,
  input: { ids: string[] },
) {
  return settleEach(input, (id) => acceptSuggestion(db, context, { id }));
}

/** Rejects each pending id as a Miss with no correction. */
export async function rejectSuggestions(
  db: Database,
  context: EntityKernelContext,
  input: { ids: string[] },
) {
  return settleEach(input, (id) => rejectSuggestion(db, context, { id }));
}

/** Sequential on purpose: accepting one Suggestion can supersede a sibling
 * later in the batch, which then reports its own failure. */
async function settleEach(
  input: { ids: string[] },
  settle: (
    id: string,
  ) => Promise<{ id: string; status: "applied" | "rejected" }>,
): Promise<SuggestionReviewBatchOut> {
  const { ids } = suggestionReviewBatchInput.parse(input);
  const results: SuggestionReviewBatchOut = [];
  for (const id of ids) {
    try {
      results.push({ ...(await settle(id)), ok: true });
    } catch (error) {
      results.push({ id, ok: false, error: getErrorMessage(error) });
    }
  }
  return results;
}

export async function rejectSuggestion(
  db: Database,
  context: EntityKernelContext | undefined,
  input: z.infer<typeof rowIdInput> & { correctValue?: unknown },
) {
  const parsedInput = rowIdInput
    .extend({ correctValue: jsonSchema.optional() })
    .parse(input);
  if (parsedInput.correctValue !== undefined) {
    if (!context)
      throw new Error("Applying a corrected value requires the entity context");
    return withTransactionDatabase(db, async (transactionDb) => {
      const [row] = await getDb(transactionDb)
        .select()
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.id, parsedInput.id),
            eq(suggestionTable.status, "pending"),
          ),
        )
        .limit(1)
        .for("update");
      if (!row)
        throw new Error(`Pending Suggestion not found: ${parsedInput.id}`);
      const parsed = suggestionRowSchema.parse(row);
      // Remove this row from the pending set before the shared write path
      // supersedes sibling Suggestions. A failure rolls both operations back.
      await getDb(transactionDb)
        .update(suggestionTable)
        .set({ status: "rejected", correctValue: parsedInput.correctValue })
        .where(eq(suggestionTable.id, parsedInput.id));
      const receipt = await applySuggestionValue(
        transactionDb,
        { ...context, db: transactionDb },
        parsed,
        parsedInput.correctValue,
        { reason: "member_correction" },
      );
      await getDb(transactionDb)
        .update(suggestionTable)
        .set({ acceptanceReceipt: receipt })
        .where(eq(suggestionTable.id, parsedInput.id));
      return { id: parsedInput.id, status: "rejected" as const };
    });
  }
  const [row] = await getDb(db)
    .select()
    .from(suggestionTable)
    .where(
      and(
        eq(suggestionTable.id, parsedInput.id),
        eq(suggestionTable.status, "pending"),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`Pending Suggestion not found: ${parsedInput.id}`);
  const decided = await getDb(db)
    .update(suggestionTable)
    .set({ status: "rejected", correctValue: parsedInput.correctValue ?? null })
    .where(
      and(
        eq(suggestionTable.id, parsedInput.id),
        eq(suggestionTable.status, "pending"),
      ),
    )
    .returning({ id: suggestionTable.id });
  if (!decided.length)
    throw new Error(`Pending Suggestion not found: ${parsedInput.id}`);
  return { id: parsedInput.id, status: "rejected" as const };
}

export async function recordFieldSuggestionMiss(
  db: Database,
  runId: RunId,
  input: {
    entity: string;
    entityId: string;
    field: string;
    currentValue: unknown;
    suggestedValue: string;
    confidence: number;
  },
) {
  const entity = fieldSuggestionsInput.shape.entity.parse(input.entity);
  const recordId = await resolveLiveShortcode(db, input.entityId, entity);
  if (!recordId)
    throw new Error(`Suggestion record not found: ${input.entityId}`);
  const [row] = await getDb(db)
    .insert(suggestionTable)
    .values({
      runId,
      entity,
      recordId,
      field: input.field,
      currentValue: input.currentValue,
      suggestedValue: input.suggestedValue,
      confidence: input.confidence,
      runnerUpValue: null,
      runnerUpConfidence: null,
      model: "field-suggest",
      pairKey: null,
      kind:
        input.currentValue == null || input.currentValue === ""
          ? "addition"
          : "correction",
      status: "pending",
    })
    .returning({ id: suggestionTable.id });
  if (!row) throw new Error("Suggestion miss was not persisted");
  await rejectSuggestion(db, undefined, { id: row.id });
  return { recorded: true as const };
}

export async function latestSuggestionSweepStatus(db: Database) {
  const [latest] = await getDb(db)
    .select({
      id: runTable.id,
      input: runTable.input,
      status: runTable.status,
      progress: runTable.progress,
    })
    .from(runTable)
    .where(eq(runTable.purpose, "suggestion_sweep"))
    .orderBy(desc(runTable.createdAt))
    .limit(1);
  if (!latest)
    return {
      latestRunId: null,
      entity: null,
      fields: [],
      taxonomyChanged: false,
      status: null,
      paused: false,
      progress: null,
    };
  const stored = z
    .object({
      taxonomyRevision: z.string().optional(),
      paused: z.boolean().optional(),
    })
    .passthrough()
    .parse(latest.input);
  const sweep = suggestionSweepRunInput.safeParse(latest.input);
  return {
    latestRunId: latest.id,
    entity: sweep.success ? sweep.data.entity : null,
    fields: sweep.success ? sweep.data.fields : [],
    taxonomyChanged:
      stored.taxonomyRevision !== (await spendingClassificationRevision(db)),
    status: latest.status,
    paused: stored.paused ?? false,
    progress: latest.progress,
  };
}
