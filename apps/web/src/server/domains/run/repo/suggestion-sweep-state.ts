import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { entityFieldEnvelopeFields } from "@cubby/schemas/entity-field-envelopes";
import { fieldEnvelopeFor, fieldValueOf } from "@cubby/schemas/field-envelope";
import type { RunId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseEntityRef } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNotNull, or, isNull } from "drizzle-orm";
import { z } from "zod";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { readSelectedEntityRecords } from "~/server/entity-kernel/selected-read";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import {
  JobEvidenceObsoleteError,
  JobTargetError,
} from "~/server/generic/jobs/errors";
import { applyAutomaticRules } from "~/server/generic/suggestions/repo/automatic-application";
import {
  fieldInputFingerprint,
  fenceFieldInputsAtCommit,
} from "~/server/generic/suggestions/repo/field-input-fence";
import {
  fieldSuggestionPublication,
  publishSuggestions,
} from "~/server/generic/suggestions/repo/suggestion";
import {
  suggestionStateColumns,
  transitionSuggestionStates,
} from "~/server/generic/suggestions/repo/suggestion-state";
import { canonicalJson } from "~/server/lib/canonical-json";

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
  currentValue: suggestionValueSchema,
  suggestedValue: suggestionValueSchema,
  confidence: z.number(),
  runnerUpValue: suggestionValueSchema,
  runnerUpConfidence: z.number().nullable(),
  model: z.string(),
});
export type SweepSuggestion = z.infer<typeof sweepSuggestionSchema>;

export async function saveSweepSuggestions(
  db: Database,
  // Automatic refresh publishes with no Run, and its slot is then unique on the record.
  runId: RunId | null,
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
      const liveInputFingerprint = await fieldInputFingerprint(
        tx,
        input.entity,
        input.recordId,
        input.field,
      );
      const saved = await getDb(tx)
        .select(suggestionStateColumns)
        .from(suggestionTable)
        .where(
          and(
            runId
              ? eq(suggestionTable.runId, runId)
              : isNull(suggestionTable.runId),
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
        throw new JobEvidenceObsoleteError(
          "Suggestion member decision changed during inference",
        );
      const code = (
        await import("~/server/generic/shortcode/repo/shortcode-resolver")
      ).lookupShortcodes;
      const codes = await code(tx, [
        parseEntityRef(input.entity, typedRecordId),
      ]);
      const publicId = codes.get(`${input.entity}:${typedRecordId}`);
      if (!publicId)
        throw new JobEvidenceObsoleteError(
          "Suggestion target no longer exists",
        );
      const txContext = {
        ...context,
        db: tx,
        actorContext: {
          ...context.actorContext,
          runId: runId ?? context.actorContext.runId,
        },
      };
      const [record] = await readSelectedEntityRecords({
        context: txContext,
        entity: input.entity,
        ids: [publicId],
        fields: [input.field],
      });
      if (!record)
        throw new JobEvidenceObsoleteError(
          "Suggestion target no longer exists",
        );
      const governed = Object.hasOwn(
        entityFieldEnvelopeFields[input.entity],
        input.field,
      );
      const envelope = fieldEnvelopeFor(record, input.field);
      // Unavailable evidence is neither empty nor obsolete. It fails this target
      // alone, so a shared publication chunk splits and its siblings still commit.
      if (governed && (!envelope || envelope.result.kind === "missing"))
        throw new JobTargetError(
          "Suggestion target field result is unavailable",
        );
      const currentValue = governed
        ? envelope && fieldValueOf(envelope)
        : record[input.field];
      if (
        canonicalJson(z.json().parse(currentValue ?? null)) !==
        canonicalJson(input.currentValue)
      )
        throw new JobEvidenceObsoleteError(
          "Suggestion target changed during inference",
        );

      const predecessors = await getDb(tx)
        .select(suggestionStateColumns)
        .from(suggestionTable)
        .where(
          and(
            eq(suggestionTable.entity, input.entity),
            eq(suggestionTable.recordId, typedRecordId),
            eq(suggestionTable.field, input.field),
            eq(suggestionTable.family, "field"),
            or(
              eq(suggestionTable.active, true),
              input.predecessorIds?.length
                ? and(
                    or(
                      eq(suggestionTable.status, "applied"),
                      isNotNull(suggestionTable.acceptanceReceipt),
                    ),
                    inArray(suggestionTable.id, input.predecessorIds),
                  )
                : undefined,
            ),
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
                (row.status === "applied" ||
                  row.acceptanceReceipt !== null ||
                  row.status === "pending" ||
                  (row.status === "superseded" &&
                    ["input_changed", "no_proposal"].includes(
                      row.supersessionReceipt?.reason ?? "",
                    ))),
            ),
        )
      )
        throw new JobEvidenceObsoleteError(
          "Suggestion was decided during inference",
        );
      if (
        input.predecessorIds &&
        predecessors.some(
          (row) =>
            row.status === "pending" && !input.predecessorIds!.includes(row.id),
        )
      )
        throw new JobEvidenceObsoleteError(
          "Suggestion target changed during inference",
        );
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
        await transitionSuggestionStates(
          tx,
          and(
            eq(suggestionTable.id, previous.id),
            eq(suggestionTable.status, "pending"),
          ),
          {
            status: "superseded",
            supersessionReceipt: {
              reason: admissible.length ? "replacement" : "no_proposal",
              evaluationId: input.evaluationId ?? null,
              at: new Date().toISOString(),
            },
          },
        );
      }
      const created: string[] = [];
      for (const entry of admissible) {
        const [row] = await publishSuggestions(tx, [
          fieldSuggestionPublication({
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
            kind: entry.kind,
            data: {
              liveInputFingerprint,
              reviewKey: entry.reviewKey ?? null,
            },
            status: "pending",
          }),
        ]);
        if (!row) throw new Error("Field publication returned no row");
        created.push(row.id);
      }
      // Proposals publish pending; a confident assignment then applies only
      // through its Automatic rule, as automatic Feedback naming the rule.
      const { applied } = await applyAutomaticRules(tx, created, {
        context: txContext,
        onFailure: (_id, error) => onApplyFailure?.(error),
      });
      await fenceFieldInputsAtCommit(
        tx,
        input.entity,
        input.recordId,
        input.field,
      );
      return applied.length
        ? ("applied" as const)
        : created.length
          ? ("queued" as const)
          : ("settled" as const);
    },
    { isolationLevel: "serializable" },
  );
}
