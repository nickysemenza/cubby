import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { requiresSuggestionReview } from "@cubby/schemas/field-suggestion";
import type { RunId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseEntityRef } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  run as runTable,
  assessmentState as suggestionTable,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
import { acceptSuggestion } from "~/server/generic/assessment/repo/suggestion-review";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/audit-log";

export type SuggestionValue =
  | string
  | number
  | boolean
  | null
  | SuggestionValue[]
  | { [key: string]: SuggestionValue };

export const suggestionValueSchema: z.ZodType<SuggestionValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(suggestionValueSchema),
    z.record(z.string(), suggestionValueSchema),
  ]),
);
export const jsonValue = (value: unknown): SuggestionValue =>
  suggestionValueSchema.parse(value);
export const sweepSuggestionSchema = z.object({
  reviewKey: z.string().nullable().optional(),
  kind: z.enum(["addition", "correction"]),
  status: z.enum(["applied", "pending"]),
  currentValue: suggestionValueSchema,
  suggestedValue: suggestionValueSchema,
  confidence: z.number(),
  runnerUpValue: suggestionValueSchema,
  runnerUpConfidence: z.number().nullable(),
  model: z.string(),
  pairKey: z.string().nullable(),
});
export type SweepSuggestion = z.infer<typeof sweepSuggestionSchema>;

export const readSuggestionSweepRun = async (db: Database, runId: RunId) => {
  const [row] = await getDb(db)
    .select()
    .from(runTable)
    .where(eq(runTable.id, runId));
  if (!row || row.purpose !== "suggestion_sweep")
    throw new Error("Suggestion sweep Run not found");
  return row;
};

/** Replaces the sweep Run's progress checkpoint. */
export async function writeSuggestionSweepProgress(
  db: Database,
  runId: RunId,
  progress: (typeof runTable.$inferInsert)["progress"],
) {
  await getDb(db)
    .update(runTable)
    .set({ progress })
    .where(eq(runTable.id, runId));
}

export async function pauseRunningSuggestionSweep(db: Database, runId: RunId) {
  await getDb(db)
    .update(runTable)
    .set({ status: "paused" })
    .where(and(eq(runTable.id, runId), eq(runTable.status, "running")));
}

export async function saveSweepSuggestions(
  db: Database,
  runId: RunId,
  input: {
    entity: FieldSuggestionsInput["entity"];
    field: string;
    recordId: string;
    currentValue: SuggestionValue;
    fieldDecisionId?: string | null;
    predecessorIds?: string[];
    evaluationId?: string;
    provenance?: import("@cubby/schemas/ai-evaluation").AiProvenance;
    /** The field's decision policy prunes an unordered set. */
    unordered: boolean;
  },
  entries: readonly SweepSuggestion[],
  financeReviewFingerprint: string | null,
  context: EntityKernelContext,
  onApplyFailure?: (error: UnparsedError) => void,
) {
  return withTransactionDatabase(
    db,
    async (tx) => {
      const typedRecordId = parseEntityId(input.entity, input.recordId);
      const saved = await getDb(tx)
        .select()
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.runId, runId),
            eq(suggestionTable.recordId, typedRecordId),
            eq(suggestionTable.field, input.field),
            eq(suggestionTable.active, true),
          ),
        );
      if (saved.length)
        return saved.some((row) => row.status === "applied")
          ? ("applied" as const)
          : ("queued" as const);
      if (
        input.fieldDecisionId !== undefined &&
        (await latestFieldWrite(tx, input.entity, typedRecordId, input.field))
          ?.id !== (input.fieldDecisionId ?? undefined)
      )
        throw new Error("Suggestion member decision changed during inference");
      const code = (
        await import("~/server/generic/shortcode/repo/shortcode-resolver")
      ).lookupShortcodes;
      const codes = await code(tx, [
        parseEntityRef(input.entity, typedRecordId),
      ]);
      const publicId = codes.get(`${input.entity}:${typedRecordId}`);
      if (!publicId) throw new Error("Suggestion target no longer exists");
      const txContext = {
        ...context,
        db: tx,
        actorContext: { ...context.actorContext, runId },
      };
      const found = await executeEntity(
        txContext,
        entityCommandSchema.parse({
          action: "get",
          entity: input.entity,
          id: publicId,
        }),
      );
      if (found.action !== "get" || !found.item)
        throw new Error("Suggestion target no longer exists");
      const record = z.record(z.string(), z.unknown()).parse(found.item);
      if (
        canonicalJson(z.json().parse(record[input.field] ?? null)) !==
        canonicalJson(input.currentValue)
      )
        throw new Error("Suggestion target changed during inference");

      const predecessors = await getDb(tx)
        .select()
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.entity, input.entity),
            eq(suggestionTable.recordId, typedRecordId),
            eq(suggestionTable.field, input.field),
            eq(suggestionTable.active, true),
          ),
        )
        .for("update");
      if (
        input.predecessorIds &&
        input.predecessorIds.some(
          (id) =>
            !predecessors.some(
              (row) =>
                row.id === id &&
                (row.status === "pending" ||
                  (row.status === "superseded" &&
                    ["input_changed", "no_proposal"].includes(
                      row.supersessionReceipt?.reason ?? "",
                    ))),
            ),
        )
      )
        throw new Error("Suggestion was decided during inference");
      if (
        input.predecessorIds &&
        predecessors.some(
          (row) =>
            row.status === "pending" && !input.predecessorIds!.includes(row.id),
        )
      )
        throw new Error("Suggestion target changed during inference");
      const rejected = predecessors.filter(
        (row) =>
          row.status === "rejected" && row.suppression?.scope === "field_value",
      );
      const reviewedWrong = await getDb(tx)
        .select({ data: suggestionTable.data })
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.family, "field"),
            eq(suggestionTable.entity, input.entity),
            eq(suggestionTable.recordId, typedRecordId),
            eq(suggestionTable.field, input.field),
            eq(suggestionTable.status, "rejected"),
          ),
        );
      const unordered = input.unordered;
      const proposalKey = (value: SuggestionValue) =>
        canonicalJson(
          unordered && Array.isArray(value)
            ? [...value].sort((left, right) =>
                canonicalJson(left).localeCompare(canonicalJson(right)),
              )
            : value,
        );
      const admissible = entries.filter(
        (entry) =>
          !reviewedWrong.some(
            (row) =>
              entry.reviewKey &&
              z.object({ reviewKey: z.string().nullable() }).safeParse(row.data)
                .data?.reviewKey === entry.reviewKey,
          ) &&
          !rejected.some(
            (row) =>
              proposalKey(jsonValue(row.suggestedValue)) ===
              proposalKey(entry.suggestedValue),
          ) &&
          !predecessors.some(
            (row) =>
              row.status === "rejected" &&
              input.provenance &&
              row.provenance &&
              proposalKey(jsonValue(row.suggestedValue)) ===
                proposalKey(entry.suggestedValue) &&
              canonicalJson(z.json().parse(row.provenance)) ===
                canonicalJson(
                  z.json().parse({ ...input.provenance, model: entry.model }),
                ),
          ),
      );
      for (const previous of predecessors) {
        if (
          previous.status !== "pending" ||
          (input.predecessorIds && !input.predecessorIds.includes(previous.id))
        )
          continue;
        await getDb(tx)
          .update(suggestionTable)
          .set({
            status: "superseded",
            supersessionReceipt: {
              reason: admissible.length ? "replacement" : "no_proposal",
              evaluationId: input.evaluationId ?? null,
              at: new Date().toISOString(),
            },
          })
          .where(
            and(
              eq(suggestionTable.id, previous.id),
              eq(suggestionTable.status, "pending"),
            ),
          );
      }
      let outcome: "applied" | "queued" = "queued";
      const created: {
        row: typeof suggestionTable.$inferSelect;
        entry: SweepSuggestion;
      }[] = [];
      for (const entry of admissible) {
        const [row] = await getDb(tx)
          .insert(suggestionTable)
          .values({
            runId,
            entity: input.entity,
            recordId: typedRecordId,
            field: input.field,
            financeReviewFingerprint,
            evaluationId: input.evaluationId,
            provenance: input.provenance
              ? { ...input.provenance, model: entry.model }
              : undefined,
            currentValue: entry.currentValue,
            suggestedValue: entry.suggestedValue,
            confidence: entry.confidence,
            runnerUpValue: entry.runnerUpValue,
            runnerUpConfidence: entry.runnerUpConfidence,
            model: entry.model,
            pairKey: entry.pairKey,
            kind: entry.kind,
            data: { reviewKey: entry.reviewKey ?? null },
            status: "pending",
          })
          .returning();
        if (row) created.push({ row, entry });
      }
      for (const { row, entry } of created) {
        if (
          entry.status === "applied" &&
          !requiresSuggestionReview(input.entity, input.field)
        ) {
          try {
            await acceptSuggestion(
              tx,
              txContext,
              { id: row.id },
              { mode: "automatic", confidence: entry.confidence },
            );
            outcome = "applied";
          } catch (error) {
            onApplyFailure?.(error);
            // The nested acceptance transaction rolled back; its pending proposal remains reviewable.
            await getDb(tx)
              .update(suggestionTable)
              .set({ status: "pending" })
              .where(eq(suggestionTable.id, row.id));
          }
        }
      }
      return outcome;
    },
    { isolationLevel: "serializable" },
  );
}
