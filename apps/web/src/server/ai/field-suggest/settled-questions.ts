import {
  fieldSuggestionOutcomeSchema,
  type FieldSuggestionOutcome,
  type FieldSuggestionsInput,
  type SettledSuggestionQuestionsInput,
} from "@cubby/schemas/ai";
import type { AiRefreshManifest } from "@cubby/schemas/ai-evaluation";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, isNull, notExists, sql } from "drizzle-orm";

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
 * policy stamps, so list pages stop re-asking it on every visit. Vocabulary
 * changes that leave the basis unchanged are revisited by AI refresh
 * discovery, not by this memory.
 */
const SETTLED_QUESTION = {
  entityKind: "global",
  feature: "field-suggestion.settled-question",
  model: "any",
  promptVersion: "1",
} as const;

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

/** Only answers that a re-ask with the same basis would repeat are remembered. */
export const isSettledOutcome = (outcome: FieldSuggestionOutcome) =>
  outcome.kind === "evaluated"
    ? outcome.answer === "none"
    : outcome.reason === "no_signal";

/** One statement per question; a repeated settle of a key adds no row. */
export async function rememberSettledQuestions(
  db: Database,
  entries: readonly { key: string; outcome: FieldSuggestionOutcome }[],
) {
  for (const { key, outcome } of entries) {
    const result = JSON.stringify(outcome);
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

/** A member's recorded miss on the remembered decline re-opens the question. */
export async function readSettledQuestions(
  db: Database,
  input: SettledSuggestionQuestionsInput,
) {
  const manifest = await producingAiManifest(db);
  const keys = await Promise.all(
    input.questions.map((question) =>
      fieldQuestionKey({ ...question, entity: input.entity }, manifest),
    ),
  );
  const rows = await getDb(db)
    .select({
      key: aiAnalysis.inputFingerprint,
      result: aiAnalysis.result,
    })
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
                sql`${feedback.assessmentId}::text = ${aiAnalysis.result}->>'assessmentId'`,
                eq(feedback.authority, "member"),
                eq(feedback.verdict, "wrong"),
              ),
            ),
        ),
      ),
    );
  const byKey = new Map(
    rows.map((row) => [
      row.key,
      fieldSuggestionOutcomeSchema.parse(row.result),
    ]),
  );
  return { outcomes: keys.map((key) => byKey.get(key) ?? null) };
}
