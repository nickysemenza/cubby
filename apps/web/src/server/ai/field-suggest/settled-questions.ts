import {
  fieldSuggestionOutcomeSchema,
  type FieldSuggestionOutcome,
  type FieldSuggestionsInput,
  type SettledSuggestionAnswer,
  type SettledSuggestionQuestion,
  type SettledSuggestionQuestionsInput,
} from "@cubby/schemas/ai";
import type { AiRefreshManifest } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
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
import { settleBatch } from "~/server/workflows/settle-batch";

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

/**
 * One statement per question. A re-settle of a key replaces its outcome and
 * signature: after its inputs change, a fresh decline must become the
 * comparison point, or every later read would reopen it again.
 */
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
      WITH replaced AS (
        UPDATE "AiAnalysis" SET "result" = ${result}::jsonb, "updatedAt" = now()
        WHERE "entityKind" = ${SETTLED_QUESTION.entityKind}
          AND "entityId" IS NULL
          AND "feature" = ${SETTLED_QUESTION.feature}
          AND "model" = ${SETTLED_QUESTION.model}
          AND "promptVersion" = ${SETTLED_QUESTION.promptVersion}
          AND "inputFingerprint" = ${key}
          AND "AiAnalysis"."deletedAt" IS NULL
        RETURNING 1
      )
      INSERT INTO "AiAnalysis"
        ("entityKind", "entityId", "feature", "model", "promptVersion", "inputFingerprint", "result")
      SELECT ${SETTLED_QUESTION.entityKind}, NULL, ${SETTLED_QUESTION.feature},
        ${SETTLED_QUESTION.model}, ${SETTLED_QUESTION.promptVersion}, ${key}, ${result}::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM replaced)`);
  }
}

type SettledPorts = Pick<SuggestFieldsPorts, "decisionPort" | "registry">;

/**
 * Re-prepares one remembered question's decision inputs from saved data,
 * without the model or any paid provider call, and compares their signature.
 */
async function recheck(
  db: Database,
  entity: SettledSuggestionQuestionsInput["entity"],
  question: SettledSuggestionQuestion,
  remembered: z.infer<typeof rememberedSchema>,
  ports: SettledPorts,
): Promise<SettledSuggestionAnswer> {
  const prepared = await withAiInputs(
    true,
    () =>
      suggestFields(
        db,
        PREPARATION_RUN,
        {
          entity,
          basisMode: question.basisMode,
          basis: question.basis,
          targets: [question.field],
        },
        { ...ports, recordUsage: false },
      ),
    { providerFree: true },
    // SILENT: a question preparation refuses is asked live, which reports
    // the raw diagnostic on its own surface.
  ).catch(() => null);
  const preparedOutcome = prepared?.result.outcomes?.[question.field];
  // Inputs that cannot be prepared for free cannot be verified: ask live
  // under a revision distinct from the remembered inputs' cache entry.
  if (!prepared || !preparedOutcome || prepared.incomplete)
    return { outcome: null, revision: `unverified:${remembered.signature}` };
  const signature = await settledSignature(
    { entity, field: question.field },
    preparedOutcome,
    prepared.inputs,
  );
  return signature === remembered.signature
    ? { outcome: remembered.outcome, revision: null }
    : { outcome: null, revision: signature };
}

/**
 * One list page batch: a single policy read and a single memory lookup for
 * every question, then a sequential free recheck of only the remembered ones,
 * so a batch holds one database connection at a time. A member's recorded
 * miss on the decline also reopens it.
 */
export async function readSettledQuestions(
  db: Database,
  input: SettledSuggestionQuestionsInput,
  ports: SettledPorts = {},
) {
  const manifest = await producingAiManifest(db);
  const keys = await Promise.all(
    input.questions.map((question) =>
      fieldQuestionKey({ ...question, entity: input.entity }, manifest),
    ),
  );
  const rows = await getDb(db)
    .select({ key: aiAnalysis.inputFingerprint, result: aiAnalysis.result })
    .from(aiAnalysis)
    .where(
      and(
        eq(aiAnalysis.entityKind, SETTLED_QUESTION.entityKind),
        isNull(aiAnalysis.entityId),
        eq(aiAnalysis.feature, SETTLED_QUESTION.feature),
        eq(aiAnalysis.model, SETTLED_QUESTION.model),
        eq(aiAnalysis.promptVersion, SETTLED_QUESTION.promptVersion),
        inArray(aiAnalysis.inputFingerprint, [...new Set(keys)]),
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
    );
  const byKey = new Map(
    rows.flatMap((row) => {
      const parsed = rememberedSchema.safeParse(row.result);
      return parsed.success ? [[row.key, parsed.data] as const] : [];
    }),
  );
  return settleBatch(
    input.questions,
    async (question, index): Promise<SettledSuggestionAnswer> => {
      const remembered = byKey.get(keys[index]!);
      return remembered
        ? recheck(db, input.entity, question, remembered, ports)
        : { outcome: null, revision: null };
    },
    { concurrency: 1 },
  );
}
