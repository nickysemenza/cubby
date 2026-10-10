import {
  fieldSuggestionsInput,
  financeCategoryApplyInput,
} from "@cubby/schemas/ai";
import type { RunId } from "@cubby/schemas/identifiers";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  run as runTable,
  suggestion as suggestionTable,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { getDb } from "~/server/repo/database-helpers";
import { spendingClassificationRevision } from "~/server/repo/expense-category-resolution";
import { applyFinanceCategorySuggestion } from "~/server/repo/finance-suggestion-context";
import { SHORTCODE_TABLE } from "~/server/repo/generated/shortcode-tables.gen";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

const rowIdInput = z.object({ id: z.string().uuid() });
const filtersSchema = z.object({
  entity: fieldSuggestionsInput.shape.entity.optional(),
  field: z.string().optional(),
  kind: z.enum(["correction", "addition"]).optional(),
  minConfidence: z.number().min(0).max(1).default(0.5),
  runId: z.string().uuid().optional(),
});
const jsonSchema = z.json();
const pageSuggestionsInput = z.object({
  entity: fieldSuggestionsInput.shape.entity,
  recordIds: z.array(z.string().uuid()).max(250),
  fields: z.array(z.string()).max(100),
});
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
  model: z.string(),
  kind: z.enum(["correction", "addition"]),
  status: z.enum(["pending", "applied", "rejected"]),
  correctValue: jsonSchema.nullable(),
  pairKey: z.string().uuid().nullable(),
});

export async function listPendingSuggestions(
  db: Database,
  rawInput: z.input<typeof filtersSchema> = {},
) {
  const input = filtersSchema.parse(rawInput);
  const conditions = [
    eq(suggestionTable.status, "pending"),
    gte(suggestionTable.confidence, input.minConfidence),
  ];
  if (input.entity) conditions.push(eq(suggestionTable.entity, input.entity));
  if (input.field) conditions.push(eq(suggestionTable.field, input.field));
  if (input.kind) conditions.push(eq(suggestionTable.kind, input.kind));
  if (input.runId)
    conditions.push(
      eq(suggestionTable.runId, parseEntityId("run", input.runId)),
    );
  const rows = await getDb(db)
    .select({ suggestion: suggestionTable, runInput: runTable.input })
    .from(suggestionTable)
    .innerJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(and(...conditions))
    .orderBy(desc(suggestionTable.confidence));
  return rows.flatMap(({ suggestion, runInput }) => {
    const decisionModel = z
      .object({ decisionModel: z.string().optional() })
      .passthrough()
      .safeParse(runInput).data?.decisionModel;
    return !suggestion.pairKey || decisionModel === suggestion.model
      ? [suggestionRowSchema.parse(suggestion)]
      : [];
  });
}

/** One bounded read for the visible list page. Stored rows take precedence over
 * live suggestions in cells; paired evaluation candidates never reach review. */
export async function listPagePendingSuggestions(
  db: Database,
  rawInput: z.input<typeof pageSuggestionsInput>,
) {
  const input = pageSuggestionsInput.parse(rawInput);
  if (!input.recordIds.length || !input.fields.length) return [];
  const rows = await getDb(db)
    .select({ suggestion: suggestionTable, runInput: runTable.input })
    .from(suggestionTable)
    .innerJoin(runTable, eq(runTable.id, suggestionTable.runId))
    .where(
      and(
        eq(suggestionTable.entity, input.entity),
        eq(suggestionTable.status, "pending"),
        inArray(suggestionTable.recordId, input.recordIds),
        inArray(suggestionTable.field, input.fields),
      ),
    );
  return rows.flatMap(({ suggestion, runInput }) => {
    const decisionModel = z
      .object({ decisionModel: z.string().optional() })
      .passthrough()
      .safeParse(runInput).data?.decisionModel;
    return !suggestion.pairKey || decisionModel === suggestion.model
      ? [suggestionRowSchema.parse(suggestion)]
      : [];
  });
}

export async function applySuggestionValue(
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
    await supersedePendingFieldSuggestions(db, entity, row.recordId, row.field);
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
  await supersedePendingFieldSuggestions(db, entity, row.recordId, row.field);
}

async function supersedePendingFieldSuggestions(
  db: Database,
  entity: z.infer<typeof fieldSuggestionsInput>["entity"],
  recordId: string,
  field: string,
) {
  await getDb(db)
    .update(suggestionTable)
    .set({ status: "superseded" })
    .where(
      and(
        eq(suggestionTable.entity, entity),
        eq(suggestionTable.recordId, parseEntityId(entity, recordId)),
        eq(suggestionTable.field, field),
        eq(suggestionTable.status, "pending"),
      ),
    );
}

export async function acceptSuggestion(
  db: Database,
  context: EntityKernelContext,
  input: z.infer<typeof rowIdInput>,
) {
  const { id } = rowIdInput.parse(input);
  const [row] = await getDb(db)
    .select()
    .from(suggestionTable)
    .where(
      and(eq(suggestionTable.id, id), eq(suggestionTable.status, "pending")),
    )
    .limit(1);
  if (!row) throw new Error(`Pending Suggestion not found: ${id}`);
  const parsed = suggestionRowSchema.parse(row);
  await applySuggestionValue(db, context, parsed, row.suggestedValue);
  await getDb(db)
    .update(suggestionTable)
    .set({ status: "applied" })
    .where(eq(suggestionTable.id, id));
  return { id, status: "applied" as const };
}

export async function acceptSuggestions(
  db: Database,
  context: EntityKernelContext,
  input: { ids: string[] },
) {
  const ids = z.array(z.string().uuid()).min(1).parse(input.ids);
  const results = [];
  for (const id of ids)
    results.push(await acceptSuggestion(db, context, { id }));
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
  const parsed = suggestionRowSchema.parse(row);
  if (parsedInput.correctValue !== undefined) {
    if (!context)
      throw new Error("Applying a corrected value requires the entity context");
    await applySuggestionValue(db, context, parsed, parsedInput.correctValue);
  }
  await getDb(db)
    .update(suggestionTable)
    .set({ status: "rejected", correctValue: parsedInput.correctValue ?? null })
    .where(eq(suggestionTable.id, parsedInput.id));
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
  return {
    latestRunId: latest.id,
    taxonomyChanged:
      stored.taxonomyRevision !== (await spendingClassificationRevision(db)),
    status: latest.status,
    paused: stored.paused ?? false,
    progress: latest.progress,
  };
}
