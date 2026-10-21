import {
  fieldSuggestionOutcomeSchema,
  type FieldSuggestionOutcome,
  type FieldSuggestionsInput,
  settledSuggestionPreview,
  suggestionStatus,
  type SettledSuggestionAnswer,
  type SettledSuggestionPreview,
  type SettledSuggestionQuestion,
  type SettledSuggestionQuestionsInput,
} from "@cubby/schemas/ai";
import type { AiRefreshManifest } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { aiAnalysis, assessmentState, feedback } from "~/server/db/schema";
import { canonicalJson } from "~/server/lib/canonical-json";
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
 *
 * A saved record's complete live answer (pick, weak pick, decline or skip)
 * is also remembered under its record ID, as a display-only preview: a list
 * revisit shows it while the live ask revalidates, and a preview read never
 * prepares inputs, so it cannot stand in for that ask.
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
const rememberedPreviewSchema = z.object({ preview: settledSuggestionPreview });

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

/** A saved record's preview key; distinct from every `fieldQuestionKey`. */
export const savedAnswerKey = (
  question: FieldQuestion & { entityId: string },
  manifest: AiRefreshManifest,
) =>
  sha256Hex(
    canonicalJson({
      savedRecord: question.entityId,
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
 * A re-settle of a key replaces its outcome and signature: after its inputs
 * change, a fresh decline must become the comparison point, or every later
 * read would reopen it again. `AiAnalysis_active_key` cannot enforce one row
 * per key (its `entityId` is always NULL here), so each replacement holds a
 * transaction lock on the key: its upsert statement then sees any concurrent
 * first insert, and the key keeps one effective row.
 */
export const rememberSettledQuestions = (
  db: Database,
  entries: readonly {
    key: string;
    outcome: FieldSuggestionOutcome;
    signature: string;
  }[],
) =>
  rememberRows(
    db,
    entries.map(({ key, outcome, signature }) => ({
      key,
      result: rememberedSchema.parse({ outcome, signature }),
    })),
  );

/** Replaces each saved record's preview with its newest live answer. */
export const rememberSavedAnswers = (
  db: Database,
  entries: readonly { key: string; preview: SettledSuggestionPreview }[],
) =>
  rememberRows(
    db,
    entries.map(({ key, preview }) => ({
      key,
      result: rememberedPreviewSchema.parse({ preview }),
    })),
  );

async function rememberRows(
  db: Database,
  entries: readonly { key: string; result: unknown }[],
) {
  for (const { key, result: value } of entries) {
    const result = JSON.stringify(value);
    await withTransactionDatabase(db, async (transactionDb) => {
      await getDb(transactionDb).execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${SETTLED_QUESTION.feature}:${key}`}, 0))`,
      );
      await getDb(transactionDb).execute(sql`
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
    });
  }
}

type SettledPorts = Pick<SuggestFieldsPorts, "decisionPort" | "registry">;

/**
 * Re-prepares one remembered question's decision inputs from saved data,
 * without the model or any paid provider call, and compares their signature.
 * A member's recorded miss (`missId`) keeps the question open; its revision
 * still names the current inputs, so a changed roster after the miss asks
 * live again instead of reusing the answer cached for the older inputs.
 */
async function recheck(
  db: Database,
  entity: SettledSuggestionQuestionsInput["entity"],
  question: SettledSuggestionQuestion,
  remembered: z.infer<typeof rememberedSchema>,
  missId: string | null,
  ports: SettledPorts,
): Promise<SettledSuggestionAnswer> {
  const missed = missId ? `miss:${missId}:` : "";
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
  // Inputs that cannot be prepared for free cannot be verified, so no earlier
  // live answer can be known to match them either: each such read asks live
  // under a revision of its own.
  if (!prepared || !preparedOutcome || prepared.incomplete)
    return {
      outcome: null,
      revision: `${missed}unverified:${crypto.randomUUID()}`,
    };
  const signature = await settledSignature(
    { entity, field: question.field },
    preparedOutcome,
    prepared.inputs,
  );
  if (missId) return { outcome: null, revision: `${missed}${signature}` };
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
  if (input.read === "preview") return readSavedAnswerPreviews(db, input);
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
      missId: sql<string | null>`(
        SELECT ${feedback.id}::text FROM ${feedback}
        WHERE ${feedback.assessmentId}::text = ${aiAnalysis.result}->'outcome'->>'assessmentId'
          AND ${feedback.authority} = ${"member"}
          AND ${feedback.verdict} = ${"wrong"}
        ORDER BY ${feedback.createdAt} DESC, ${feedback.id} DESC
        LIMIT 1
      )`,
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
      ),
    )
    // Rows written before replacements were serialized may share a key; the
    // newest is the effective one.
    .orderBy(desc(aiAnalysis.updatedAt), desc(aiAnalysis.id));
  const byKey = new Map<
    string,
    { remembered: z.infer<typeof rememberedSchema>; missId: string | null }
  >();
  for (const row of rows) {
    const parsed = rememberedSchema.safeParse(row.result);
    if (parsed.success && !byKey.has(row.key))
      byKey.set(row.key, { remembered: parsed.data, missId: row.missId });
  }
  return settleBatch(
    input.questions,
    async (question, index): Promise<SettledSuggestionAnswer> => {
      const entry = byKey.get(keys[index]!);
      if (!entry) {
        // A first read can establish structural source eligibility without
        // model inference or inventing a historical answer.
        const prepared = await withAiInputs(
          true,
          () =>
            suggestFields(
              db,
              PREPARATION_RUN,
              {
                entity: input.entity,
                basisMode: question.basisMode,
                basis: question.basis,
                targets: [question.field],
              },
              { ...ports, recordUsage: false },
            ),
          { providerFree: true },
        );
        const outcome = prepared?.result.outcomes?.[question.field];
        return {
          outcome:
            !prepared?.incomplete && outcome?.kind === "skipped"
              ? outcome
              : null,
          revision: null,
        };
      }
      // A member's recorded miss reopens the question under that review's
      // identity, so the live answer cached before it is never restored.
      return recheck(
        db,
        input.entity,
        question,
        entry.remembered,
        entry.missId,
        ports,
      );
    },
    { concurrency: 1 },
  );
}

/**
 * One policy read and one memory lookup for a page batch, nothing else: no
 * preparation, model call, scheduling or Run. A preview whose answer a review
 * withheld — the answer's own rejection or supersession, a rejection of the
 * same served evidence, or a member's miss — is not returned, so the live ask
 * decides it again.
 */
async function readSavedAnswerPreviews(
  db: Database,
  input: SettledSuggestionQuestionsInput,
) {
  const manifest = await producingAiManifest(db);
  const keys = await Promise.all(
    input.questions.map(({ entityId, ...question }) =>
      entityId
        ? savedAnswerKey(
            { ...question, entity: input.entity, entityId },
            manifest,
          )
        : null,
    ),
  );
  const lookups = [
    ...new Set(keys.filter((key): key is string => key !== null)),
  ];
  const preview = sql`${aiAnalysis.result}->${"preview"}::text`;
  const answerAssessment = sql`coalesce(
    ${preview}->${"outcome"}::text->>${"assessmentId"}::text,
    ${preview}->${"suggestion"}::text->>${"assessmentId"}::text
  )`;
  const { rejected, superseded } = suggestionStatus.enum;
  const rows = lookups.length
    ? await getDb(db)
        .select({
          key: aiAnalysis.inputFingerprint,
          result: aiAnalysis.result,
          withheld: sql<boolean>`(
            EXISTS (
              SELECT 1 FROM ${assessmentState} AS "answer"
              WHERE "answer"."id"::text = ${answerAssessment}
                AND (
                  "answer"."status" IN (${rejected}, ${superseded})
                  OR EXISTS (
                    SELECT 1 FROM ${assessmentState} AS "sibling"
                    WHERE "sibling"."family" = ${"field"}
                      AND "sibling"."status" = ${rejected}
                      AND "sibling"."data"->>${"reviewKey"}::text
                        = "answer"."data"->>${"reviewKey"}::text
                  )
                )
            )
            OR EXISTS (
              SELECT 1 FROM ${feedback}
              WHERE ${feedback.assessmentId}::text = ${answerAssessment}
                AND ${feedback.authority} = ${"member"}
                AND ${feedback.verdict} = ${"wrong"}
            )
          )`,
        })
        .from(aiAnalysis)
        .where(
          and(
            eq(aiAnalysis.entityKind, SETTLED_QUESTION.entityKind),
            isNull(aiAnalysis.entityId),
            eq(aiAnalysis.feature, SETTLED_QUESTION.feature),
            eq(aiAnalysis.model, SETTLED_QUESTION.model),
            eq(aiAnalysis.promptVersion, SETTLED_QUESTION.promptVersion),
            inArray(aiAnalysis.inputFingerprint, lookups),
            isNull(aiAnalysis.deletedAt),
          ),
        )
        .orderBy(desc(aiAnalysis.updatedAt), desc(aiAnalysis.id))
    : [];
  const byKey = new Map<string, SettledSuggestionPreview | null>();
  for (const row of rows) {
    if (byKey.has(row.key)) continue;
    const parsed = rememberedPreviewSchema.safeParse(row.result);
    if (!parsed.success) continue;
    byKey.set(
      row.key,
      row.withheld || parsed.data.preview.outcome.reviewStatus === "rejected"
        ? null
        : parsed.data.preview,
    );
  }
  return settleBatch(
    input.questions,
    async (_question, index): Promise<SettledSuggestionAnswer> => {
      const key = keys[index];
      return {
        outcome: null,
        revision: null,
        preview: key ? (byKey.get(key) ?? null) : null,
      };
    },
    { concurrency: 1 },
  );
}
