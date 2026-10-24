import {
  assessmentChildHandle,
  assessmentPublication,
  assessmentJudgments,
  assessmentProjectionTargets,
  feedbackAuthority,
  feedbackEvent,
} from "@cubby/schemas/assessment";
import { CORRECTION_OUTCOME_RECEIPT_KIND } from "@cubby/schemas/suggestion-correction";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import {
  assessment,
  assessmentState,
  feedback,
} from "~/server/db/retained-tables";
import {
  recordAssessmentChange,
  recordChange,
} from "~/server/generic/changes/repo/change";

import {
  assessmentProjectionSnapshot,
  insertPublishedAssessmentStates,
} from "./assessment-state";
import { fieldInputFingerprint } from "./field-input-fence";

/** A matching operation ID alone never proves that a domain mutation committed. */
export function assertApplicationReceipt(
  receipt: typeof feedback.$inferSelect,
  command: typeof feedback.$inferSelect,
  kind: string,
) {
  const metadata = z
    .object({ kind: z.string(), commandFeedbackId: assessmentChildHandle })
    .safeParse(receipt.metadata);
  if (
    !metadata.success ||
    metadata.data.kind !== kind ||
    metadata.data.commandFeedbackId !== command.id ||
    receipt.assessmentId !== command.assessmentId ||
    receipt.authority !== command.authority ||
    !["member", "automatic"].includes(receipt.authority) ||
    receipt.intent !== "apply" ||
    receipt.actorUserId !== command.actorUserId ||
    receipt.suppression !== null ||
    receipt.receipt === null
  )
    throw new Error("Invalid immutable application receipt for this command");
}

/**
 * `<ruleKey>@<revision>` of the Automatic rule whose application receipt an
 * Assessment carries, else null: the "applied automatically" mark.
 */
export const automaticApplicationRule = (assessmentId: SQL) => sql<
  string | null
>`(SELECT CASE WHEN f.metadata->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND} THEN 'member-correction@1'
    ELSE (f.metadata->${"rule"}->>${"key"}) || '@' || (f.metadata->${"rule"}->>${"revision"}) END
  FROM "Feedback" f WHERE f."assessmentId" = ${assessmentId}
    AND f.authority = ${feedbackAuthority.enum.automatic}
    AND (f.metadata->>${"kind"} = ${"assessment_application"}
      OR (f.metadata->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND} AND f.receipt->>${"status"} = ${"applied"}))
  ORDER BY f."createdAt" DESC, f.id DESC
  LIMIT 1)`;

/** The rule stamps an AssessmentState's publication matched. */
export const matchedRulesOf = (data: SQL) =>
  sql<unknown>`CASE WHEN jsonb_typeof(${data}->'matchedRules') = 'array' THEN ${data}->'matchedRules' ELSE '[]'::jsonb END`;

/** Publishes immutable evidence atomically, returning one row per input in order. */
export async function publishAssessments(
  db: Database,
  entries: readonly {
    input: z.input<typeof assessmentPublication>;
    projection?: Partial<typeof assessmentState.$inferInsert>;
  }[],
) {
  // Validate every publication and creation snapshot before any writes.
  const prepared = entries.map(({ input: raw, projection = {} }) => {
    const input = assessmentPublication.parse(raw);
    assessmentJudgments[input.family].parse(input.judgment);
    const suggestedValue =
      projection.suggestedValue === undefined
        ? input.judgment
        : projection.suggestedValue;
    const target =
      input.subject.kind === "evaluation_sample"
        ? null
        : input.subject.kind === "email_link" && input.subject.recordId === null
          ? { entity: "orderMailEvent", recordId: input.subject.eventId }
          : input.subject.recordId === null
            ? null
            : {
                entity: input.subject.entity,
                recordId: input.subject.recordId,
              };
    // The creation snapshot is the row's first state; rebuild replays it.
    const state = target && {
      ...assessmentProjectionTargets[input.family].parse({
        ...target,
        ...projection,
      }),
      field: input.subject.kind === "field" ? input.subject.field : "",
      fingerprint: input.fingerprint,
      ...(input.subject.kind === "run_finding" && {
        ledgerPartyId: input.subject.ledgerPartyId,
      }),
      ...projection,
      suggestedValue,
    };
    return {
      input,
      state,
      snapshot: state && assessmentProjectionSnapshot(state),
    };
  });
  if (!prepared.length) return [];
  const publications = new Map<string, (typeof prepared)[number]>();
  for (const entry of prepared) {
    const previous = publications.get(entry.input.publicationKey);
    if (previous && !isEqual(previous.input, entry.input))
      throw new Error(
        "Assessment publication retry changed immutable evidence",
      );
    // Sequential replays keep the first creation projection for this key.
    if (!previous) publications.set(entry.input.publicationKey, entry);
  }
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const inserted = await client
      .insert(assessment)
      .values(
        [...publications.values()].map(({ input, snapshot }) => ({
          ...input,
          judgment:
            input.judgment === null ? sql`'null'::jsonb` : input.judgment,
          projection: snapshot,
        })),
      )
      .onConflictDoNothing({ target: assessment.publicationKey })
      .returning();
    const rowsByKey = new Map(inserted.map((row) => [row.publicationKey, row]));
    const conflicts = [...publications.keys()].filter(
      (key) => !rowsByKey.has(key),
    );
    if (conflicts.length) {
      const existing = await client
        .select()
        .from(assessment)
        .where(inArray(assessment.publicationKey, conflicts));
      for (const row of existing) rowsByKey.set(row.publicationKey, row);
    }
    const rows = prepared.map(({ input }) => {
      const row = rowsByKey.get(input.publicationKey);
      if (!row) throw new Error("Assessment publication returned no row");
      if (!isEqual(input, assessmentPublication.parse(row)))
        throw new Error(
          "Assessment publication retry changed immutable evidence",
        );
      return row;
    });
    await insertPublishedAssessmentStates(
      transactionDb,
      inserted.flatMap((row) => {
        const state = publications.get(row.publicationKey)?.state;
        return state ? [{ ...state, id: row.id, family: row.family }] : [];
      }),
    );
    const correctionTargets = inserted.filter(
      (row) => row.family === "field" || row.family === "image_description",
    );
    if (correctionTargets.length) {
      await recordAssessmentChange(transactionDb, {
        kind: "publications",
        ids: correctionTargets.map((row) => row.id),
      });
    }
    if (
      inserted.some(
        (row) =>
          row.family === "email_relevance" || row.family === "email_link",
      )
    )
      await recordChange(transactionDb, {
        kind: "source",
        categories: ["email"],
      });
    return rows;
  });
}

/** A publication key names exact immutable evidence, never a mutable slot. */
export async function publishAssessment(
  db: Database,
  raw: z.input<typeof assessmentPublication>,
  projection: Partial<typeof assessmentState.$inferInsert> = {},
) {
  const [row] = await publishAssessments(db, [{ input: raw, projection }]);
  if (!row) throw new Error("Assessment publication returned no row");
  return row;
}

/** Field producers publish evidence before its live projection; serving is a producer decision. */
export async function publishFieldAssessment(
  db: Database,
  projection: Omit<typeof assessmentState.$inferInsert, "id" | "family"> & {
    field: string;
  },
  served: boolean,
) {
  const data = z.record(z.string(), z.json()).parse(projection.data ?? {});
  if (projection.status === undefined || projection.status === "pending") {
    if (!("connectionEvidence" in data) && !("liveInputFingerprint" in data)) {
      data.liveInputFingerprint = await fieldInputFingerprint(
        db,
        projection.entity,
        projection.recordId,
        projection.field,
      );
    }
  }
  const model = projection.model ?? "unknown";
  return publishAssessment(
    db,
    {
      publicationKey: `field:${crypto.randomUUID()}`,
      family: "field",
      subject: {
        kind: "field",
        entity: projection.entity,
        recordId: projection.recordId,
        field: projection.field,
      },
      judgment: {
        value: z.json().parse(projection.suggestedValue ?? null),
        confidence: projection.confidence ?? 0,
        runnerUpValue: z.json().parse(projection.runnerUpValue ?? null),
        runnerUpConfidence: projection.runnerUpConfidence ?? null,
        kind: projection.kind ?? "addition",
      },
      fingerprint:
        projection.provenance?.inputFingerprint ??
        projection.financeReviewFingerprint ??
        null,
      producer:
        model === "unknown"
          ? null
          : {
              kind: "model",
              model,
              revision: null,
              runId: projection.runId ?? null,
              evaluationId: projection.evaluationId ?? null,
            },
      evidence: {
        currentValue: z.json().parse(projection.currentValue ?? null),
        provenance: projection.provenance ?? null,
        correctionKey: data.correctionKey ?? null,
        ...(data.correctionRecipe
          ? { correctionRecipe: data.correctionRecipe }
          : {}),
      },
      served,
    },
    { ...projection, data },
  );
}

/** Recording a grade is independent of applying a correction or changing authority. */
export async function recordFeedback(
  db: Database,
  raw: z.input<typeof feedbackEvent>,
) {
  const input = feedbackEvent.parse(raw);
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const [prediction] = await client
      .select({ served: assessment.served, family: assessment.family })
      .from(assessment)
      .where(eq(assessment.id, input.assessmentId))
      .limit(1);
    if (!prediction) throw new Error("Assessment not found");
    if (!prediction.served && input.authority === "member")
      throw new Error(
        "Unserved trial assessments are not member review candidates",
      );
    if (
      input.authority === "evaluation" &&
      (input.intent !== "history" || input.suppression)
    )
      throw new Error(
        "Evaluation Feedback cannot apply or suppress operational results",
      );
    const [inserted] = await client
      .insert(feedback)
      .values(input)
      .onConflictDoNothing({
        target: [feedback.assessmentId, feedback.operationId],
      })
      .returning();
    const row =
      inserted ??
      (
        await client
          .select()
          .from(feedback)
          .where(
            and(
              eq(feedback.assessmentId, input.assessmentId),
              eq(feedback.operationId, input.operationId),
            ),
          )
          .limit(1)
      )[0];
    if (!row) throw new Error("Feedback publication returned no row");
    if (!isEqual(input, feedbackEvent.parse(row)))
      throw new Error("Immutable Feedback retry changed its event");
    if (
      inserted &&
      row.authority === "member" &&
      row.intent === "apply" &&
      row.receipt !== null
    ) {
      await recordAssessmentChange(transactionDb, {
        kind: "application",
        receiptId: row.id,
      });
    }
    if (
      inserted &&
      (prediction.family === "email_relevance" ||
        prediction.family === "email_link")
    )
      await recordChange(transactionDb, {
        kind: "source",
        categories: ["email"],
      });
    return row;
  });
}
