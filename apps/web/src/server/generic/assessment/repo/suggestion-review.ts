import {
  fieldSuggestionsInput,
  financeCategoryApplyInput,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionReviewListInput,
  suggestionStatus,
} from "@cubby/schemas/ai";
import { SUGGESTION_AUTO_APPLY_THRESHOLD } from "@cubby/schemas/ai-evaluation";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import { assessmentChildHandle } from "@cubby/schemas/assessment";
import { entityRefKey } from "@cubby/schemas/entity";
import { requiresSuggestionReview } from "@cubby/schemas/field-suggestion";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { suggestionSweepRunInput } from "@cubby/schemas/run-fields";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  run as runTable,
  assessmentState as suggestionTable,
} from "~/server/db/schema";
import { spendingClassificationRevision } from "~/server/domains/expense/repo/expense-category-resolution";
import { applyFinanceCategorySuggestion } from "~/server/domains/financial-transaction/repo/finance-suggestion-context";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { recordFeedback } from "~/server/generic/assessment/repo/assessment";
import { withAuditReceipts } from "~/server/generic/audit-log/repo/audit-receipts";
import {
  lookupShortcodes,
  resolveLiveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";

/** Shared executions publish one suggestion history; every live requester can inspect it. */
const requestedSuggestionRun = (code: string) => sql`(
  ${runTable.shortcode} = ${code} OR EXISTS (
    SELECT 1 FROM "AiEvaluationRequest" AS demand JOIN "Run" AS requester ON requester.id = demand."runId"
    WHERE demand."evaluationId" = ${suggestionTable.evaluationId} AND demand."cancelledAt" IS NULL
      AND requester.shortcode = ${code} AND requester."deletedAt" IS NULL
  )
)`;

const rowIdInput = z.object({ id: assessmentChildHandle });
const jsonSchema = z.json();
const suggestionRowSchema = z.object({
  id: assessmentChildHandle,
  runId: z.string().uuid().nullable(),
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

/** A paired trial row is reviewable only when it is the model its Run
 * served; public rows name their Run by shortcode. */
function reviewableRow(
  suggestion: typeof suggestionTable.$inferSelect,
  runCode: string | null,
) {
  return [{ ...suggestionRowSchema.parse(suggestion), runId: runCode }];
}
/** Served-trial authority outlives nullable Run provenance. */
export const reviewableSuggestionSql = sql`EXISTS (SELECT 1 FROM "Assessment" prediction WHERE prediction.id=${suggestionTable.id} AND prediction.served)`;

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
    eq(suggestionTable.family, "field"),
    eq(suggestionTable.active, true),
    eq(suggestionTable.status, input.status),
    gte(suggestionTable.confidence, input.minConfidence),
  ];
  if (input.entity) conditions.push(eq(suggestionTable.entity, input.entity));
  if (input.field) conditions.push(eq(suggestionTable.field, input.field));
  if (input.kind) conditions.push(eq(suggestionTable.kind, input.kind));
  if (input.runId) conditions.push(requestedSuggestionRun(input.runId));
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
    .leftJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(and(...conditions))
    .orderBy(
      input.status === "pending"
        ? desc(suggestionTable.confidence)
        : desc(suggestionTable.updatedAt),
      suggestionTable.id,
    )
    .limit(input.limit);
  const reviewable = rows.flatMap(({ suggestion, runCode }) =>
    reviewableRow(suggestion, runCode),
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
            assessmentId: row.id,
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
    .leftJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(
      and(
        reviewableSuggestionSql,
        eq(suggestionTable.family, "field"),
        runId ? requestedSuggestionRun(runId) : undefined,
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
    if (automatic && requiresSuggestionReview(parsed.entity, parsed.field))
      throw new Error(
        `Field ${parsed.entity}.${parsed.field} requires member review`,
      );
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
    await recordFeedback(transactionDb, {
      assessmentId: id,
      operationId: "saved-application",
      verdict: "correct",
      authority: automatic ? "automatic" : "member",
      actorUserId: context.actorContext.userId,
      intent: "apply",
      receipt: z.json().parse(receipt),
    });
    return { id, status: "applied" as const };
  });
}

export async function applyFieldCorrection(
  db: Database,
  context: EntityKernelContext,
  input: z.infer<typeof rowIdInput> & { correctValue: unknown },
) {
  const parsedInput = rowIdInput
    .extend({ correctValue: jsonSchema })
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
      await recordFeedback(transactionDb, {
        assessmentId: parsedInput.id,
        operationId: "saved-correction",
        verdict: "wrong",
        authority: "member",
        actorUserId: context.actorContext.userId,
        intent: "apply",
        correction: {
          present: true,
          value: z.json().parse(parsedInput.correctValue),
        },
        receipt: z.json().parse(receipt),
      });
      return { id: parsedInput.id, status: "rejected" as const };
    });
  }
  throw new Error("Field correction requires an explicit corrected value");
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
    paused: latest.status === "paused",
    progress: latest.progress,
  };
}
