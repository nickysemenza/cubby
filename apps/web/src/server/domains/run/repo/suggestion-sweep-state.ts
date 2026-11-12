import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import type { FieldAutomationCause } from "@cubby/schemas/ai-evaluation";
import { entityFieldEnvelopeFields } from "@cubby/schemas/entity-field-envelopes";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { RunId } from "@cubby/schemas/identifiers";
import { parseEntityId, parseEntityRef } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNotNull, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { fieldEnvelopeAtPath, readPathValue } from "~/entity/read-path";
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
  type SuggestionPublication,
} from "~/server/generic/suggestions/repo/suggestion";
import {
  publishSuggestionSet,
  type SuggestionFamily,
  type SuggestionRow,
} from "~/server/generic/suggestions/repo/suggestion-publication";
import {
  suggestionStateColumns,
  transitionSuggestionStates,
  type SuggestionStateRow,
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

type SweepPolicy = {
  predecessors: readonly SuggestionStateRow[];
  predecessorIds: readonly string[] | undefined;
  evaluationId: string | null;
  provenance: import("@cubby/schemas/ai-evaluation").AiProvenance | undefined;
  unordered: boolean;
};

type SweepCandidate = {
  entry: SweepSuggestion;
  policy: SweepPolicy;
  target: { entity: string; recordId: string; field: string };
  publication: SuggestionPublication;
};

/** Pending predecessors give way with the receipt of what replaced them. */
async function supersedePredecessors(
  tx: Database,
  policy: SweepPolicy,
  reason: "replacement" | "no_proposal",
) {
  for (const previous of policy.predecessors) {
    if (
      previous.status !== "pending" ||
      (policy.predecessorIds && !policy.predecessorIds.includes(previous.id))
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
          reason,
          evaluationId: policy.evaluationId,
          at: new Date().toISOString(),
        },
      },
    );
  }
}

const proposalKey = (unordered: boolean, value: SuggestionValue) =>
  canonicalJson(
    unordered && Array.isArray(value)
      ? [...value].sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        )
      : value,
  );

/**
 * Sweep field proposals: one slot per record field. A proposal a member
 * rejected, by value, served evidence or review key, never publishes. Earlier
 * rows stay active and in place, since decisions and queued evaluations name
 * them; a replacement supersedes only pending predecessors, with its receipt.
 */
const fieldSweepSuggestions: SuggestionFamily<
  SweepCandidate,
  SuggestionRow,
  "rejected",
  {
    id: string;
    active: boolean;
    suggestedValue: unknown;
    provenance: unknown;
    suppression: SuggestionStateRow["suppression"];
    data: unknown;
  }[]
> = {
  family: "field",
  slot: ({ target }) => ({
    lock: `field:${target.entity}:${target.recordId}:${target.field}`,
    fields: target,
  }),
  fingerprint: ({ publication }) => publication.input.fingerprint ?? "",
  evidenceFingerprint: ({ publication }) => publication.input.fingerprint ?? "",
  suppresses: () => false,
  obsolete: () => true,
  onUnchanged: "none",
  replaced: "keep",
  // A sweep publishes one record field at a time.
  load: async (tx, [candidate]) =>
    !candidate
      ? []
      : getDb(tx)
          .select({
            id: suggestionTable.id,
            active: suggestionTable.active,
            suggestedValue: suggestionTable.suggestedValue,
            provenance: suggestionTable.provenance,
            suppression: suggestionTable.suppression,
            data: suggestionTable.data,
          })
          .from(suggestionTable)
          .where(
            and(
              eq(suggestionTable.family, "field"),
              eq(suggestionTable.status, "rejected"),
              eq(suggestionTable.entity, candidate.target.entity),
              eq(suggestionTable.recordId, candidate.target.recordId),
              eq(suggestionTable.field, candidate.target.field),
            ),
          ),
  precheck: async (_tx, { entry, policy }, _rows, _producer, { loaded }) => {
    const key = proposalKey(policy.unordered, entry.suggestedValue);
    const sameValue = (row: (typeof loaded)[number]) =>
      proposalKey(policy.unordered, jsonValue(row.suggestedValue)) === key;
    const rejected = loaded.some(
      (row) =>
        (entry.reviewKey &&
          z.object({ reviewKey: z.string().nullable() }).safeParse(row.data)
            .data?.reviewKey === entry.reviewKey) ||
        (row.active &&
          sameValue(row) &&
          (row.suppression?.scope === "field_value" ||
            (policy.provenance &&
              row.provenance &&
              canonicalJson(z.json().parse(row.provenance)) ===
                canonicalJson(
                  z.json().parse({ ...policy.provenance, model: entry.model }),
                )))),
    );
    return rejected ? { kind: "resolved", reason: "rejected" } : undefined;
  },
  prepare: async (tx, candidate, _rows, producer) => {
    await supersedePredecessors(tx, candidate.policy, "replacement");
    return { candidate, producer };
  },
  publication: ({ publication }) => publication,
  labelBacklog: sql`false`,
};

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
    /** This transaction's fingerprint of the field's inputs, when the caller already read it. */
    liveInputFingerprint?: string;
    /** The field's decision policy prunes an unordered set. */
    unordered: boolean;
    /** Why field automation asked; Changes by Cubby groups by it. */
    cause?: FieldAutomationCause;
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
      const liveInputFingerprint =
        input.liveInputFingerprint ??
        (await fieldInputFingerprint(
          tx,
          input.entity,
          input.recordId,
          input.field,
        ));
      const saved = await getDb(tx)
        .select(suggestionStateColumns)
        .from(suggestionTable)
        .where(
          and(
            runId
              ? eq(suggestionTable.runId, runId)
              : // An automatic slot already holds the prior answer; only a
                // replay of this evaluation is already saved.
                and(
                  isNull(suggestionTable.runId),
                  input.evaluationId
                    ? eq(suggestionTable.evaluationId, input.evaluationId)
                    : undefined,
                ),
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
      const model = entityFieldModels[input.entity].fields.find(
        (field) => field.key === input.field,
      );
      const path = model?.display.readPath ?? model?.readKey;
      const root = path?.split(/[.[]/u, 1)[0];
      if (!path || !root)
        throw new Error("Suggestion field has no declared read path");
      const [record] = await readSelectedEntityRecords({
        context: txContext,
        entity: input.entity,
        ids: [publicId],
        fields: [root],
      });
      if (!record)
        throw new JobEvidenceObsoleteError(
          "Suggestion target no longer exists",
        );
      const governed = Object.hasOwn(
        entityFieldEnvelopeFields[input.entity],
        root,
      );
      const envelope = fieldEnvelopeAtPath(record, path);
      const currentValue = readPathValue(record, path);
      // Unavailable evidence is neither empty nor obsolete. It fails this target
      // alone. Mutation aliases such as ingredientId read an ordinary nullable
      // relation; a loaded null root is empty, but a missing root is unavailable.
      if (
        envelope?.result.kind === "missing" ||
        (governed && !envelope) ||
        (currentValue === undefined && readPathValue(record, root) !== null)
      )
        throw new JobTargetError(
          "Suggestion target field result is unavailable",
        );
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
      const policy: SweepPolicy = {
        predecessors,
        predecessorIds: input.predecessorIds,
        evaluationId: input.evaluationId ?? null,
        provenance: input.provenance,
        unordered: input.unordered,
      };
      const outcomes = await publishSuggestionSet(
        tx,
        fieldSweepSuggestions,
        entries.map((entry) => ({
          entry,
          policy,
          target: {
            entity: input.entity,
            recordId: typedRecordId,
            field: input.field,
          },
          publication: fieldSuggestionPublication({
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
              ...(input.cause && { cause: input.cause }),
            },
            status: "pending",
          }),
        })),
        {
          kind: "model",
          model: null,
          revision: null,
          runId,
          evaluationId: input.evaluationId ?? null,
        },
      );
      const created = outcomes.flatMap((outcome) =>
        outcome.outcome === "published" ? [outcome.suggestionId] : [],
      );
      if (!created.length)
        await supersedePredecessors(tx, policy, "no_proposal");
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
