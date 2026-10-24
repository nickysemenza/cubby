import {
  fieldSuggestionsInput,
  financeCategoryApplyInput,
  suggestionReviewListInput,
  suggestionStatus,
} from "@cubby/schemas/ai";
import { aiProvenance } from "@cubby/schemas/ai-evaluation";
import { SUGGESTION_AUTO_APPLY_THRESHOLD } from "@cubby/schemas/ai-evaluation";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import { assessmentChildHandle } from "@cubby/schemas/assessment";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import { fieldResolutionsSchema } from "@cubby/schemas/field-resolution";
import {
  basisValueOf,
  requiresSuggestionReview,
} from "@cubby/schemas/field-suggestion";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import { suggestionSweepRunInput } from "@cubby/schemas/run-fields";
import { suggestionFieldCount } from "@cubby/schemas/suggestion-list";
import { type SQL, and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  dependenciesCurrent,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  getDb,
  runBeforeCommitDatabase,
  withTransactionDatabase,
  uuidArrayParam,
} from "~/server/db/helpers";
import {
  run as runTable,
  assessmentState as suggestionTable,
} from "~/server/db/schema";
import {
  captureConnectionBasis,
  connectionBasisIsCurrent,
  connectionReadEvidence,
} from "~/server/domains/connection/repo/connection-evidence";
import { spendingClassificationRevision } from "~/server/domains/expense/repo/expense-category-resolution";
import { applyFinanceCategorySuggestion } from "~/server/domains/financial-transaction/repo/finance-suggestion-context";
import { executeEntity, executeEntityAs } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import {
  automaticApplicationRule,
  matchedRulesOf,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { transitionAssessmentState } from "~/server/generic/assessment/repo/assessment-state";
import {
  fieldInputFingerprint,
  fieldInputFingerprintIfLive,
  fenceFieldInputsAtCommit,
} from "~/server/generic/assessment/repo/field-input-fence";
import { withAuditReceipts } from "~/server/generic/audit-log/repo/audit-receipts";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import {
  lookupShortcodes,
  resolveLiveShortcodes,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { canonicalJson } from "~/server/lib/canonical-json";

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
  createdAt: z.date().transform((value) => value.toISOString()),
});

/** Public rows name their Run by shortcode. */
function reviewableRow(
  suggestion: typeof suggestionTable.$inferSelect,
  runCode: string | null,
) {
  return [{ ...suggestionRowSchema.parse(suggestion), runId: runCode }];
}
/** Only served Assessments are member review candidates. */
export const reviewableSuggestionSql = sql`EXISTS (SELECT 1 FROM "Assessment" prediction WHERE prediction.id=${suggestionTable.id} AND prediction.served)`;

/** Pending review queue, or reviewed history by `status` (the label set a
 * decision eval replays). Every filter composes, including a list page's
 * `recordIds` and `fields`. Unserved Assessments never appear. */
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
  return presentFieldRows(db, rows);
}

type StoredFieldRow = {
  suggestion: typeof suggestionTable.$inferSelect;
  runCode: string | null;
};

/** Public queue rows: records and receipt Runs named by shortcode. */
async function presentFieldRows(db: Database, rows: StoredFieldRow[]) {
  const currentRows: StoredFieldRow[] = [];
  for (const row of rows) {
    const suggestion = row.suggestion;
    if (suggestion.status === "pending") {
      const data = z.record(z.string(), z.json()).parse(suggestion.data);
      if ("connectionEvidence" in data) {
        const evidence = connectionReadEvidence.safeParse(
          data.connectionEvidence,
        );
        if (
          !evidence.success ||
          !(await connectionBasisIsCurrent(
            db,
            suggestion.id,
            await captureConnectionBasis(db, evidence.data.candidate),
          ))
        )
          continue;
      } else {
        if (
          typeof data.liveInputFingerprint !== "string" ||
          data.liveInputFingerprint !==
            (await fieldInputFingerprintIfLive(
              db,
              suggestion.entity,
              suggestion.recordId,
              suggestion.field,
            ))
        )
          continue;
      }
    }
    currentRows.push(row);
  }
  const reviewable = currentRows.flatMap(({ suggestion, runCode }) =>
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

/** Reviewable field suggestions by Assessment id, in no particular order. */
export async function readFieldSuggestions(
  db: Database,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  const rows = await getDb(db)
    .select({ suggestion: suggestionTable, runCode: runTable.shortcode })
    .from(suggestionTable)
    .leftJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(
      and(
        eq(suggestionTable.family, "field"),
        inArray(suggestionTable.id, [...ids]),
        reviewableSuggestionSql,
      ),
    );
  return presentFieldRows(db, rows);
}

/** The list facts of every reviewable field suggestion for a roster, entity or Run. */
export async function fieldSuggestionKeys(
  db: Database,
  scope: {
    status: z.infer<typeof suggestionStatus>;
    entities?: readonly string[];
    recordUuids?: readonly string[];
    runId?: string;
    assessmentIds?: readonly string[];
  },
) {
  const conditions: (SQL | undefined)[] = [
    eq(suggestionTable.family, "field"),
    eq(suggestionTable.active, true),
    eq(suggestionTable.status, scope.status),
    scope.assessmentIds
      ? sql`${suggestionTable.id} = ANY(${uuidArrayParam(scope.assessmentIds)})`
      : undefined,
    scope.entities
      ? inArray(suggestionTable.entity, [...scope.entities])
      : undefined,
    scope.recordUuids
      ? inArray(suggestionTable.recordId, [...scope.recordUuids])
      : undefined,
    scope.runId ? requestedSuggestionRun(scope.runId) : undefined,
    reviewableSuggestionSql,
  ];
  if (scope.entities?.length === 0 || scope.recordUuids?.length === 0)
    return [];
  return getDb(db)
    .select({
      id: suggestionTable.id,
      fingerprint: suggestionTable.fingerprint,
      entity: suggestionTable.entity,
      field: suggestionTable.field,
      kind: suggestionTable.kind,
      confidence: suggestionTable.confidence,
      createdAt: suggestionTable.createdAt,
      matchedRules: matchedRulesOf(sql`${suggestionTable.data}`),
      automaticRule: automaticApplicationRule(sql`${suggestionTable.id}`),
    })
    .from(suggestionTable)
    .leftJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(and(...conditions));
}

/** Outcome counts per (entity, field), optionally for one Run. */
export async function suggestionCounts(
  db: Database,
  { runId, entity }: { runId?: string; entity?: string } = {},
) {
  const count = (status: z.infer<typeof suggestionStatus> | "resolved") =>
    sql<number>`count(*) FILTER (WHERE ${suggestionTable.status} = ${status})::int`;
  const rows = await getDb(db)
    .select({
      entity: suggestionTable.entity,
      field: suggestionTable.field,
      pending: count(suggestionStatus.enum.pending),
      applied: count(suggestionStatus.enum.applied),
      rejected: count(suggestionStatus.enum.rejected),
      superseded: count(suggestionStatus.enum.superseded),
      resolved: count("resolved"),
    })
    .from(suggestionTable)
    .leftJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(
      and(
        reviewableSuggestionSql,
        eq(suggestionTable.family, "field"),
        runId ? requestedSuggestionRun(runId) : undefined,
        entity ? eq(suggestionTable.entity, entity) : undefined,
      ),
    )
    .groupBy(suggestionTable.entity, suggestionTable.field)
    .orderBy(suggestionTable.entity, suggestionTable.field);
  return z.array(suggestionFieldCount).parse(rows);
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

/** Reuse the field writer without rewriting the original Assessment or its receipt. */
export async function writePropagatedFieldCorrection(
  db: Database,
  context: EntityKernelContext,
  row: Pick<
    z.infer<typeof suggestionRowSchema>,
    "entity" | "recordId" | "field" | "financeReviewFingerprint"
  >,
  value: z.infer<ReturnType<typeof z.json>>,
) {
  const { auditIds } = await withAuditReceipts(() =>
    writeSuggestionValue(db, context, row, value),
  );
  await fenceFieldInputsAtCommit(db, row.entity, row.recordId, row.field);
  return { auditIds };
}

async function applySuggestionValue(
  db: Database,
  context: EntityKernelContext,
  row: z.infer<typeof suggestionRowSchema>,
  value: unknown,
  options: {
    mode?: "automatic" | "member";
    reason?: "confident_assignment" | "member_acceptance" | "member_correction";
    confidence?: number;
  } = {},
) {
  const suppliedValue = z.json().parse(value);
  const { auditIds } = await withAuditReceipts(() =>
    writeSuggestionValue(db, context, row, suppliedValue),
  );
  const receipt = suggestionAcceptanceReceipt.parse({
    mode: options.mode ?? "member",
    runId: context.actorContext.runId,
    auditIds,
    acceptedAt: new Date().toISOString(),
    reason: options.reason ?? "member_acceptance",
    confidence: options.confidence ?? null,
    threshold:
      options.mode === "automatic" ? SUGGESTION_AUTO_APPLY_THRESHOLD : null,
  });
  // Capture advances dependency revisions after business writes. Only the
  // mutable projection gets this settled fingerprint; history stays immutable.
  await runBeforeCommitDatabase(
    db,
    async (tx) => {
      const appliedInputFingerprint = await fieldInputFingerprint(
        tx,
        row.entity,
        row.recordId,
        row.field,
      );
      await transitionAssessmentState(
        tx,
        row.id,
        { acceptanceReceipt: { ...receipt, appliedInputFingerprint } },
        { kind: "field_input_settled" },
      );
    },
    "capture",
  );
  return receipt;
}

/** Automatic fill never turns a proposal into authority over a member decision. */
async function automaticFieldFillRefusal(
  db: Database,
  context: EntityKernelContext,
  row: typeof suggestionTable.$inferSelect,
  authority: "model" | "confirmed_correction" = "model",
) {
  const entity = fieldSuggestionsInput.shape.entity.parse(row.entity);
  const policy = entityFieldByKey(entity, row.field)?.control?.suggest;
  const empty = (value: unknown) => value == null || value === "";
  if (
    !row.active ||
    row.suppression ||
    row.kind !== "addition" ||
    policy?.mode !== "fill" ||
    requiresSuggestionReview(entity, row.field) ||
    (authority === "model" &&
      row.confidence < SUGGESTION_AUTO_APPLY_THRESHOLD) ||
    !empty(row.currentValue) ||
    empty(row.suggestedValue) ||
    (authority === "model" &&
      row.runnerUpConfidence !== null &&
      row.confidence - row.runnerUpConfidence < 0.1)
  )
    return `Field ${row.entity}.${row.field} is not eligible for automatic fill`;
  const [served] = await getDb(db)
    .select({ id: suggestionTable.id })
    .from(suggestionTable)
    .where(and(eq(suggestionTable.id, row.id), reviewableSuggestionSql));
  if (!served) return "Only a served field suggestion can apply automatically";
  const provenance = aiProvenance.safeParse(row.provenance);
  const manifest = await producingAiManifest(db);
  if (
    !provenance.success ||
    !fieldDependencyKeys(entity, row.field).every((feature) =>
      provenance.data.dependencies.some((stamp) => stamp.feature === feature),
    ) ||
    !dependenciesCurrent(provenance.data, manifest)
  )
    return "Automatic fill requires current complete AI policy provenance";
  const table = SHORTCODE_TABLE[entity];
  const [record] = await getDb(db)
    .select({ shortcode: table.shortcode })
    .from(table)
    .where(eq(table.id, row.recordId))
    .limit(1);
  if (!record) return "Automatic fill subject no longer exists";
  const result = await executeEntityAs({ ...context, db }, "get", {
    entity,
    id: record.shortcode,
    missing: "null",
  });
  if (!result.item) return "Automatic fill subject no longer exists";
  const live = z.record(z.string(), z.unknown()).parse(result.item);
  const resolutions = fieldResolutionsSchema.parse(live.fieldResolutions ?? {});
  const resolution = resolutions[row.field];
  if (resolution?.mode === "none" || resolution?.mode === "explicit")
    return "Automatic fill preserves an existing field decision";
  const effective = resolution ? resolution.value : live[row.field];
  if (!empty(effective))
    return "Automatic fill preserves populated effective values";
  if (
    !policy.basis.some(
      (key) => key !== row.field && basisValueOf(live[key]) !== null,
    )
  )
    return "Automatic fill requires supporting field evidence";
  // A saved clear is intentional too; unchanged saves advance the fingerprint.
  if (await latestFieldWrite(db, entity, row.recordId, row.field))
    return "Automatic fill preserves an existing field decision";
  const rejected = await getDb(db)
    .select({ value: suggestionTable.suggestedValue })
    .from(suggestionTable)
    .where(
      and(
        eq(suggestionTable.family, "field"),
        eq(suggestionTable.entity, row.entity),
        eq(suggestionTable.recordId, row.recordId),
        eq(suggestionTable.field, row.field),
        eq(suggestionTable.status, "rejected"),
      ),
    );
  if (
    rejected.some(
      (previous) =>
        canonicalJson(z.json().parse(previous.value)) ===
        canonicalJson(z.json().parse(row.suggestedValue)),
    )
  )
    return "Automatic fill preserves a rejected value";
  return null;
}

/** Confirmed correction authority replaces model certainty, never field or member safeguards. */
export async function confirmedFieldFillRefusal(
  db: Database,
  context: EntityKernelContext,
  row: typeof suggestionTable.$inferSelect,
) {
  return automaticFieldFillRefusal(db, context, row, "confirmed_correction");
}

/** Read-only preflight; acceptance repeats all checks inside its write fence. */
export async function canAutomaticallyFillField(
  db: Database,
  context: EntityKernelContext,
  id: string,
) {
  const [row] = await getDb(db)
    .select()
    .from(suggestionTable)
    .where(
      and(eq(suggestionTable.id, id), eq(suggestionTable.status, "pending")),
    );
  if (!row) return false;
  const fence = z
    .object({ liveInputFingerprint: z.string() })
    .safeParse(row.data);
  if (
    !fence.success ||
    fence.data.liveInputFingerprint !==
      (await fieldInputFingerprintIfLive(
        db,
        row.entity,
        row.recordId,
        row.field,
      ))
  )
    return false;
  return (await automaticFieldFillRefusal(db, context, row)) === null;
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
    const fence = z
      .object({ liveInputFingerprint: z.string() })
      .safeParse(row.data);
    if (
      !fence.success ||
      fence.data.liveInputFingerprint !==
        (await fieldInputFingerprint(
          transactionDb,
          parsed.entity,
          parsed.recordId,
          parsed.field,
          { lock: true },
        ))
    )
      throw new Error(
        "Suggestion inputs changed; evaluate this field again before applying",
      );
    if (automatic) {
      const refusal = await automaticFieldFillRefusal(
        transactionDb,
        context,
        row,
      );
      if (refusal) throw new Error(refusal);
    }
    // The shared write path excludes this row by status while superseding its
    // pending siblings. A failed application rolls the status transition back.
    await transitionAssessmentState(
      transactionDb,
      id,
      { status: "applied" },
      { kind: "field_applied" },
    );
    const receipt = await applySuggestionValue(
      transactionDb,
      { ...context, db: transactionDb },
      parsed,
      row.suggestedValue,
      automatic ? { ...automatic, reason: "confident_assignment" } : {},
    );
    await transitionAssessmentState(
      transactionDb,
      id,
      { acceptanceReceipt: receipt },
      { kind: "field_applied" },
    );
    await recordFeedback(transactionDb, {
      assessmentId: id,
      operationId: "saved-application",
      verdict: "correct",
      authority: automatic ? "automatic" : "member",
      actorUserId: context.actorContext.userId,
      intent: "apply",
      receipt: z.json().parse(receipt),
    });
    await fenceFieldInputsAtCommit(
      transactionDb,
      parsed.entity,
      parsed.recordId,
      parsed.field,
    );
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
      await transitionAssessmentState(
        transactionDb,
        parsedInput.id,
        { status: "rejected", correctValue: parsedInput.correctValue },
        { kind: "field_corrected" },
      );
      const receipt = await applySuggestionValue(
        transactionDb,
        { ...context, db: transactionDb },
        parsed,
        parsedInput.correctValue,
        { reason: "member_correction" },
      );
      await transitionAssessmentState(
        transactionDb,
        parsedInput.id,
        { acceptanceReceipt: receipt },
        { kind: "field_corrected" },
      );
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
      await fenceFieldInputsAtCommit(
        transactionDb,
        parsed.entity,
        parsed.recordId,
        parsed.field,
      );
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
