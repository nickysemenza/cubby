import {
  fieldSuggestionOutcomeSchema,
  type FieldSuggestionOutcome,
  type FieldSuggestionsInput,
  type SettledSuggestionQuestionInput,
} from "@cubby/schemas/ai";
import type { AiRefreshManifest } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { z } from "zod";

import {
  type CapturedInput,
  withAiInputs,
} from "~/server/ai/evaluation-inputs";
import {
  suggestFields,
  type SuggestFieldsPorts,
} from "~/server/ai/field-suggest/suggest-fields";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { aiAnalysis, feedback } from "~/server/db/schema";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";

/**
 * A declined or signal-less field question is remembered in the shared
 * `AiAnalysis` cache, keyed by the client basis plus the field's decision
 * policy stamps, so list pages stop re-asking it on every visit.
 *
 * The basis is not everything a decision reads: rosters (a new Category or
 * Project), linked records (a Product's category behind an inventory
 * location question) and stock tallies come from saved data. So the memory
 * also keeps a signature of the decision inputs the answer was computed from,
 * and a read re-prepares those inputs on the live roster/rendering path
 * without calling the model (the same preparation AI refresh discovery
 * fingerprints). Any change to what the model would have read reopens the
 * question. AI refresh discovery never sees these drafts; this check is what
 * revisits them.
 */
const SETTLED_QUESTION = {
  entityKind: "global",
  feature: "field-suggestion.settled-question",
  model: "any",
  promptVersion: "2",
} as const;

/** Preparation records no usage, so it needs no real Run. */
const PREPARATION_RUN = runEntityId.parse(
  "00000000-0000-4000-8000-000000000000",
);

const rememberedSchema = z.object({
  outcome: fieldSuggestionOutcomeSchema,
  signature: z.string(),
});

type FieldQuestion = Pick<FieldSuggestionsInput, "basisMode" | "basis"> & {
  entity: string;
  field: string;
};

export const fieldQuestionKey = (
  question: FieldQuestion,
  manifest: AiRefreshManifest,
) =>
  sha256Hex(
    canonicalJson({
      entity: question.entity,
      field: question.field,
      basisMode: question.basisMode,
      basis: question.basis,
      dependencies: dependencyStamps(
        manifest,
        fieldDependencyKeys(question.entity, question.field),
      ),
    }),
  );

/** Only answers that a re-ask with the same inputs would repeat are remembered. */
export const isSettledOutcome = (outcome: FieldSuggestionOutcome) =>
  outcome.kind === "evaluated"
    ? outcome.answer === "none"
    : outcome.reason === "no_signal";

/** The outcome's kind plus every decision input this field's answer read. */
export const settledSignature = (
  question: Pick<FieldQuestion, "entity" | "field">,
  outcome: FieldSuggestionOutcome,
  inputs: readonly CapturedInput[],
) =>
  sha256Hex(
    canonicalJson({
      kind: outcome.kind,
      reason: outcome.kind === "skipped" ? outcome.reason : null,
      inputs: inputs
        .filter(
          (call) =>
            call.operation ===
            `suggestFields.${question.entity}.${question.field}`,
        )
        .map((call) => call.fingerprint)
        .sort(),
    }),
  );

/** One statement per question; a repeated settle of a key adds no row. */
export async function rememberSettledQuestions(
  db: Database,
  entries: readonly {
    key: string;
    outcome: FieldSuggestionOutcome;
    signature: string;
  }[],
) {
  for (const { key, outcome, signature } of entries) {
    const result = JSON.stringify(
      rememberedSchema.parse({ outcome, signature }),
    );
    await getDb(db).execute(sql`
      INSERT INTO "AiAnalysis"
        ("entityKind", "entityId", "feature", "model", "promptVersion", "inputFingerprint", "result")
      SELECT ${SETTLED_QUESTION.entityKind}, NULL, ${SETTLED_QUESTION.feature},
        ${SETTLED_QUESTION.model}, ${SETTLED_QUESTION.promptVersion}, ${key}, ${result}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM "AiAnalysis"
        WHERE "entityKind" = ${SETTLED_QUESTION.entityKind}
          AND "entityId" IS NULL
          AND "feature" = ${SETTLED_QUESTION.feature}
          AND "model" = ${SETTLED_QUESTION.model}
          AND "promptVersion" = ${SETTLED_QUESTION.promptVersion}
          AND "inputFingerprint" = ${key}
          AND "AiAnalysis"."deletedAt" IS NULL
      )`);
  }
}

/**
 * The remembered outcome while its basis, policy and prepared decision inputs
 * are unchanged; a member's recorded miss on the decline also reopens it.
 */
export async function readSettledQuestion(
  db: Database,
  input: SettledSuggestionQuestionInput,
  ports: Pick<SuggestFieldsPorts, "decisionPort" | "registry"> = {},
): Promise<{ outcome: FieldSuggestionOutcome | null }> {
  const manifest = await producingAiManifest(db);
  const key = await fieldQuestionKey(input, manifest);
  const [row] = await getDb(db)
    .select({ result: aiAnalysis.result })
    .from(aiAnalysis)
    .where(
      and(
        eq(aiAnalysis.entityKind, SETTLED_QUESTION.entityKind),
        isNull(aiAnalysis.entityId),
        eq(aiAnalysis.feature, SETTLED_QUESTION.feature),
        eq(aiAnalysis.model, SETTLED_QUESTION.model),
        eq(aiAnalysis.promptVersion, SETTLED_QUESTION.promptVersion),
        eq(aiAnalysis.inputFingerprint, key),
        isNull(aiAnalysis.deletedAt),
        notExists(
          getDb(db)
            .select({ id: feedback.id })
            .from(feedback)
            .where(
              and(
                sql`${feedback.assessmentId}::text = ${aiAnalysis.result}->'outcome'->>'assessmentId'`,
                eq(feedback.authority, "member"),
                eq(feedback.verdict, "wrong"),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  const remembered = row ? rememberedSchema.safeParse(row.result) : null;
  if (!remembered?.success) return { outcome: null };
  const prepared = await withAiInputs(
    true,
    () =>
      suggestFields(
        db,
        PREPARATION_RUN,
        {
          entity: input.entity,
          basisMode: input.basisMode,
          basis: input.basis,
          targets: [input.field],
        },
        { ...ports, recordUsage: false },
      ),
    // SILENT: a question preparation refuses is asked live, which reports
    // the raw diagnostic on its own surface.
  ).catch(() => null);
  const preparedOutcome = prepared?.result.outcomes?.[input.field];
  if (!prepared || !preparedOutcome) return { outcome: null };
  const signature = await settledSignature(
    input,
    preparedOutcome,
    prepared.inputs,
  );
  return {
    outcome:
      signature === remembered.data.signature ? remembered.data.outcome : null,
  };
}
