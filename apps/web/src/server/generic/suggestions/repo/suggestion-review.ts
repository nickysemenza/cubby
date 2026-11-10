import {
  fieldSuggestionsInput,
  financeCategoryApplyInput,
  suggestionStatus,
} from "@cubby/schemas/ai";
import { aiProvenance } from "@cubby/schemas/ai-evaluation";
import { HIGH_CONFIDENCE_PROBABILITY } from "@cubby/schemas/ai-evaluation";
import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldEnvelopeFields } from "@cubby/schemas/entity-field-envelopes";
import { entityFieldByKey } from "@cubby/schemas/entity-fields";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import { basisValueOf } from "@cubby/schemas/field-suggestion";
import {
  financeReviewContext,
  suggestApplyPolicy,
} from "@cubby/schemas/field-suggestion-policy";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import {
  suggestionChildHandle,
  suggestionFamily,
} from "@cubby/schemas/suggestion";
import { suggestionFieldCount } from "@cubby/schemas/suggestion-list";
import { type SQL, and, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
import { notDeleted } from "~/server/db/helpers/predicates";
import { run as runTable, suggestionTable } from "~/server/db/schema";
import {
  captureConnectionBasis,
  connectionBasisIsCurrent,
  connectionReadEvidence,
} from "~/server/domains/connection/repo/connection-evidence";
import { applyFinanceCategorySuggestion } from "~/server/domains/financial-transaction/repo/finance-suggestion-context";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { readSelectedEntityRecords } from "~/server/entity-kernel/selected-read";
import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";
import { withAuditReceipts } from "~/server/generic/audit-log/repo/audit-receipts";
import { lookupShortcodes } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { fieldAuthority } from "~/server/generic/suggestions/repo/field-authority";
import {
  fieldInputFingerprint,
  fieldInputFingerprintIfLive,
  readFieldInputs,
  fenceFieldInputsAtCommit,
} from "~/server/generic/suggestions/repo/field-input-fence";
import {
  automaticApplicationRule,
  matchedRulesOf,
  recordFeedback,
} from "~/server/generic/suggestions/repo/suggestion";
import {
  type SuggestionStateRow,
  suggestionStateColumns,
  suggestionRecordId,
  transitionSuggestionState,
} from "~/server/generic/suggestions/repo/suggestion-state";
import { canonicalJson } from "~/server/lib/canonical-json";

/** Shared executions publish one suggestion history; every live requester can inspect it. */
const requestedSuggestionRun = (code: string) => sql`(
  ${runTable.shortcode} = ${code} OR EXISTS (
    SELECT 1 FROM "AiEvaluationRequest" AS demand JOIN "Run" AS requester ON requester.id = demand."runId"
    WHERE demand."evaluationId" = ${suggestionTable.evaluationId} AND demand."cancelledAt" IS NULL
      AND requester.shortcode = ${code} AND ${notDeleted("requester")}
  )
)`;

const rowIdInput = z.object({ id: suggestionChildHandle });
const jsonSchema = z.json();
const suggestionRowSchema = z.object({
  id: suggestionChildHandle,
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
function reviewableRow(suggestion: SuggestionStateRow, runCode: string | null) {
  return [
    {
      ...suggestionRowSchema.parse(suggestion),
      runId: runCode,
    },
  ];
}
/** Saved records are member review candidates. */
// An answer for an unsaved record has nothing to review against.
const reviewableSuggestionSql = isNotNull(suggestionTable.recordId);

type StoredFieldRow = {
  suggestion: SuggestionStateRow;
  runCode: string | null;
};

/** Public queue rows: records and receipt Runs named by shortcode. */
async function presentFieldRows(db: Database, rows: StoredFieldRow[]) {
  const ordinary = rows.flatMap(({ suggestion }) => {
    if (suggestion.status !== "pending" || suggestion.recordId === null)
      return [];
    const data = z.record(z.string(), z.json()).parse(suggestion.data);
    return !("connectionEvidence" in data) &&
      typeof data.liveInputFingerprint === "string"
      ? [{ ...suggestion, recordId: suggestion.recordId }]
      : [];
  });
  const current = await readFieldInputs(
    db,
    ordinary.map(({ entity, recordId, field }) => ({
      entity,
      recordId,
      field,
    })),
  );
  const fingerprints = new Map(
    ordinary.map(({ id }, index) => [id, current[index]?.fingerprint]),
  );
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
          data.liveInputFingerprint !== fingerprints.get(suggestion.id)
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
            suggestionId: row.id,
            recordId,
            provenance: stored?.provenance ?? null,
            acceptanceReceipt,
            supersessionReceipt,
          },
        ]
      : [];
  });
}

/** Reviewable field suggestions by Suggestion id, in no particular order. */
export async function readFieldSuggestions(
  db: Database,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  const rows = await getDb(db)
    .select({ suggestion: suggestionStateColumns, runCode: runTable.shortcode })
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
    suggestionIds?: readonly string[];
  },
) {
  const conditions: (SQL | undefined)[] = [
    eq(suggestionTable.family, "field"),
    eq(suggestionTable.active, true),
    eq(suggestionTable.status, scope.status),
    scope.suggestionIds
      ? sql`${suggestionTable.id} = ANY(${uuidArrayParam(scope.suggestionIds)})`
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
  const rows = await getDb(db)
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
      recordId: suggestionTable.recordId,
      // A Disagreement the member already answered is never listed again.
      answered: sql<boolean>`EXISTS (
        SELECT 1 FROM "Suggestion" earlier
        WHERE earlier.family = ${suggestionFamily.enum.field} AND earlier.entity = ${suggestionTable.entity}
          AND earlier."recordId" = ${suggestionTable.recordId}
          AND earlier.field = ${suggestionTable.field}
          AND earlier.status = ${suggestionStatus.enum.rejected}
          AND earlier."suggestedValue" = ${suggestionTable.suggestedValue}
      )`,
    })
    .from(suggestionTable)
    .leftJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(and(...conditions));
  return rows;
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
    .where(eq(sql`${table.id}`, row.recordId))
    .limit(1);
  if (!record) throw new Error(`Suggestion record not found: ${row.recordId}`);
  if (financeReviewContext(entity, row.field)) {
    if (!row.financeReviewFingerprint)
      throw new Error(
        "Suggestion is missing its finance review fingerprint; request a fresh suggestion.",
      );
    const financeInput = financeCategoryApplyInput.parse({
      entity,
      entityId: record.shortcode,
      fingerprint: row.financeReviewFingerprint,
      field: row.field,
      [row.field]: typedValue,
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
      options.mode === "automatic" ? HIGH_CONFIDENCE_PROBABILITY : null,
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
      await transitionSuggestionState(tx, row.id, {
        acceptanceReceipt: { ...receipt, appliedInputFingerprint },
      });
    },
    "capture",
  );
  return receipt;
}

/**
 * A replacement of Cubby's own value must win by this much. Decision-model
 * probabilities sum to 1, so at a bar of 0.60 or more the winner already leads
 * every other answer by this margin; it stays as the conservative statement of
 * "beats the current value".
 */
const REPLACEMENT_MARGIN = 0.2;

/**
 * Cubby fills an open field and revises a value it set itself; it never
 * overwrites a value a member, an import or an agent decided.
 */
async function automaticFieldRefusal(
  db: Database,
  context: EntityKernelContext,
  row: SuggestionStateRow,
) {
  const entity = fieldSuggestionsInput.shape.entity.parse(row.entity);
  const recordId = suggestionRecordId(row);
  const policy = entityFieldByKey(entity, row.field)?.control?.suggest;
  const empty = (value: unknown) => value == null || value === "";
  if (
    !row.active ||
    row.suppression ||
    policy?.mode !== "fill" ||
    suggestApplyPolicy(entity, row.field) !== "auto" ||
    row.confidence < HIGH_CONFIDENCE_PROBABILITY ||
    empty(row.suggestedValue)
  )
    return `Field ${row.entity}.${row.field} is not eligible for automatic fill`;
  const [saved] = await getDb(db)
    .select({ id: suggestionTable.id })
    .from(suggestionTable)
    .where(and(eq(suggestionTable.id, row.id), reviewableSuggestionSql));
  if (!saved) return "Only a saved field suggestion can apply automatically";
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
    .where(eq(sql`${table.id}`, row.recordId))
    .limit(1);
  if (!record) return "Automatic fill subject no longer exists";
  const [live] = await readSelectedEntityRecords({
    context: { ...context, db },
    entity,
    ids: [record.shortcode],
    fields: [row.field, ...policy.basis],
  });
  if (!live) return "Automatic fill subject no longer exists";
  const governed = (key: string) =>
    Object.hasOwn(entityFieldEnvelopeFields[entity], key);
  if (
    !policy.basis.some((key) => {
      const source = fieldEnvelopeFor(live, key);
      const value = governed(key) ? source && fieldValueOf(source) : live[key];
      return key !== row.field && basisValueOf(value) !== null;
    })
  )
    return "Automatic fill requires supporting field evidence";
  const authority = await fieldAuthority(db, entity, recordId, row.field);
  if (authority.holder === "person")
    return "Automatic fill preserves a person's value";
  const envelope = fieldEnvelopeFor(live, row.field);
  // Explicit None set at creation has no update audit row; it is a decision.
  if (envelope?.current.assignment?.kind === "none")
    return "Automatic fill preserves an existing field decision";
  if (governed(row.field) && (!envelope || envelope.result.kind === "missing"))
    return "Automatic fill requires an available current field result";
  const effective = governed(row.field)
    ? envelope && fieldValueOf(envelope)
    : live[row.field];
  if (authority.holder === "open" && !empty(effective))
    return "Automatic fill preserves populated effective values";
  const sameValue = (value: unknown) =>
    canonicalJson(z.json().parse(value)) ===
    canonicalJson(z.json().parse(row.suggestedValue));
  if (authority.holder === "cubby" && !empty(effective)) {
    if (policy.fillOnly)
      return "Other records inherit this field; Cubby only fills it";
    if (row.confidence - (row.runnerUpConfidence ?? 0) < REPLACEMENT_MARGIN)
      return "A replacement must clearly beat Cubby's current value";
  }
  const previous = await getDb(db)
    .select({
      value: suggestionTable.suggestedValue,
      status: suggestionTable.status,
      receipt: suggestionTable.acceptanceReceipt,
    })
    .from(suggestionTable)
    .where(
      and(
        eq(suggestionTable.family, "field"),
        eq(suggestionTable.entity, row.entity),
        eq(suggestionTable.recordId, recordId),
        eq(suggestionTable.field, row.field),
        inArray(suggestionTable.status, ["rejected", "superseded", "applied"]),
      ),
    );
  if (
    previous.some(
      (earlier) => earlier.status === "rejected" && sameValue(earlier.value),
    )
  )
    return "Automatic fill preserves a rejected value";
  // A value Cubby replaced is never applied again, so two answers cannot flap.
  if (
    authority.holder === "cubby" &&
    previous.some(
      (earlier) =>
        sameValue(earlier.value) &&
        suggestionAcceptanceReceipt.safeParse(earlier.receipt).data?.mode ===
          "automatic",
    )
  )
    return "Cubby already replaced this value once";
  return null;
}

/** Read-only preflight; acceptance repeats all checks inside its write fence. */
export async function canAutomaticallyFillField(
  db: Database,
  context: EntityKernelContext,
  id: string,
) {
  const [row] = await getDb(db)
    .select(suggestionStateColumns)
    .from(suggestionTable)
    .where(
      and(eq(suggestionTable.id, id), eq(suggestionTable.status, "pending")),
    );
  if (!row?.recordId) return false;
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
  return (await automaticFieldRefusal(db, context, row)) === null;
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
      .select(suggestionStateColumns)
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
      const refusal = await automaticFieldRefusal(transactionDb, context, row);
      if (refusal) throw new Error(refusal);
    }
    // The shared write path excludes this row by status while superseding its
    // pending siblings. A failed application rolls the status transition back.
    await transitionSuggestionState(transactionDb, id, { status: "applied" });
    const receipt = await applySuggestionValue(
      transactionDb,
      { ...context, db: transactionDb },
      parsed,
      row.suggestedValue,
      automatic ? { ...automatic, reason: "confident_assignment" } : {},
    );
    await transitionSuggestionState(transactionDb, id, {
      acceptanceReceipt: receipt,
    });
    await recordFeedback(transactionDb, {
      suggestionId: id,
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
        .select(suggestionStateColumns)
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
      await transitionSuggestionState(transactionDb, parsedInput.id, {
        status: "rejected",
        correctValue: parsedInput.correctValue,
      });
      const receipt = await applySuggestionValue(
        transactionDb,
        { ...context, db: transactionDb },
        parsed,
        parsedInput.correctValue,
        { reason: "member_correction" },
      );
      await transitionSuggestionState(transactionDb, parsedInput.id, {
        acceptanceReceipt: receipt,
      });
      await recordFeedback(transactionDb, {
        suggestionId: parsedInput.id,
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
