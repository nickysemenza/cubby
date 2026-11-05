import {
  assessmentChildHandle,
  assessmentPublication,
  mailDecisionFamily,
  assessmentJudgments,
  assessmentProjectionTargets,
  feedbackAuthority,
  feedbackEvent,
  suggestionDecision,
} from "@cubby/schemas/assessment";
import { connectionCandidate } from "@cubby/schemas/entity-connections";
import {
  CORRECTION_OUTCOME_RECEIPT_KIND,
  correctionAuthorityReceiptKinds,
} from "@cubby/schemas/suggestion-correction";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { suggestionTable } from "~/server/db/retained-tables";
import { appendEmailReview } from "~/server/domains/email/repo/email-review-store";
import { recordChange } from "~/server/generic/changes/repo/change";

import { fieldInputFingerprint } from "./field-input-fence";
import {
  decisionForOperation,
  type StoredDecision,
} from "./suggestion-decisions";

const candidateKey = connectionCandidate.keyof().enum;

/** A matching operation ID alone never proves that a domain mutation committed. */
export function assertApplicationReceipt(
  receipt: StoredDecision,
  command: StoredDecision,
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
  FROM "Suggestion" owner
  CROSS JOIN LATERAL jsonb_to_recordset(owner.decisions) f(metadata jsonb, receipt jsonb, authority text, "createdAt" text, id text)
  WHERE owner.id = ${assessmentId}
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
    projection?: Partial<typeof suggestionTable.$inferInsert>;
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
    if (mailDecisionFamily.safeParse(input.family).success)
      throw new Error("Mail decisions live with their domain owners");
    const { entity, recordId } = input.subject;
    const state = {
      // An answer for an unsaved record has no target to validate yet.
      ...(recordId === null
        ? { entity, recordId }
        : assessmentProjectionTargets[input.family].parse({
            entity,
            recordId,
            ...projection,
          })),
      field: input.subject.kind === "field" ? input.subject.field : "",
      fingerprint: input.fingerprint,
      ...projection,
      suggestedValue,
    };
    return { input, state };
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
      .insert(suggestionTable)
      .values(
        [...publications.values()].map(({ input, state }) => ({
          ...input,
          ...state,
          family: input.family,
          judgment:
            input.judgment === null ? sql`'null'::jsonb` : input.judgment,
          // A JSON null suggestion stays a JSON value, not SQL NULL.
          suggestedValue:
            state.suggestedValue === null
              ? sql`'null'::jsonb`
              : state.suggestedValue,
        })),
      )
      .onConflictDoNothing({ target: suggestionTable.publicationKey })
      .returning();
    const rowsByKey = new Map(inserted.map((row) => [row.publicationKey, row]));
    const conflicts = [...publications.keys()].filter(
      (key) => !rowsByKey.has(key),
    );
    if (conflicts.length) {
      const existing = await client
        .select()
        .from(suggestionTable)
        .where(inArray(suggestionTable.publicationKey, conflicts));
      for (const row of existing) rowsByKey.set(row.publicationKey, row);
    }
    const rows = prepared.map(({ input }) => {
      const row = rowsByKey.get(input.publicationKey);
      if (!row) throw new Error("Assessment publication returned no row");
      // State may later take its own fingerprint; a retry compares what it proposed.
      if (
        !isEqual(
          { ...input, fingerprint: null },
          { ...assessmentPublication.parse(row), fingerprint: null },
        )
      )
        throw new Error(
          "Assessment publication retry changed immutable evidence",
        );
      return row;
    });
    if (inserted.length)
      await recordChange(transactionDb, {
        kind: "projection",
        categories: [
          ...new Set([
            "ai",
            "suggestions",
            "problems",
            ...inserted.map((row) => row.entity),
          ]),
        ],
      });
    return rows;
  });
}

/** A publication key names exact immutable evidence, never a mutable slot. */
export async function publishAssessment(
  db: Database,
  raw: z.input<typeof assessmentPublication>,
  projection: Partial<typeof suggestionTable.$inferInsert> = {},
) {
  const [row] = await publishAssessments(db, [{ input: raw, projection }]);
  if (!row) throw new Error("Assessment publication returned no row");
  return row;
}

/** Field producers publish evidence before its live projection; serving is a producer decision. */
export async function publishFieldAssessment(
  db: Database,
  projection: Omit<
    typeof suggestionTable.$inferInsert,
    "id" | "family" | "publicationKey" | "subject" | "judgment"
  > & {
    field: string;
    recordId: string;
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
  return (await recordFeedbackWithInsertion(db, raw)).event;
}

/** Domain command capture needs insertion novelty, never timestamp-based replay inference. */
export async function recordFeedbackWithInsertion(
  db: Database,
  raw: z.input<typeof feedbackEvent>,
) {
  const input = feedbackEvent.parse(raw);
  const { assessmentId, ...event } = input;
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const [prediction] = await client
      .select({
        served: suggestionTable.served,
        family: suggestionTable.family,
        subject: suggestionTable.subject,
        decisions: suggestionTable.decisions,
        // Only the endpoints: evidence need not cross per review.
        candidate: sql<unknown>`jsonb_build_object(${sql.join(
          [candidateKey.relation, candidateKey.source, candidateKey.target].map(
            (key) =>
              sql`${key}::text, ${suggestionTable.evidence}->'candidate'->${key}`,
          ),
          sql`, `,
        )})`,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, assessmentId))
      .for("update");
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
    const existing = decisionForOperation(
      assessmentId,
      prediction.decisions,
      input.operationId,
    );
    if (existing) {
      const {
        id: _id,
        createdAt: _at,
        assessmentId: _owner,
        ...stored
      } = existing;
      if (!isEqual(event, stored))
        throw new Error("Immutable Feedback retry changed its event");
      return { event: existing, inserted: false };
    }
    const row: StoredDecision = suggestionDecision
      .extend({ assessmentId: assessmentChildHandle })
      .parse({
        ...event,
        assessmentId,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });
    const { assessmentId: _owner, ...decision } = row;
    await client
      .update(suggestionTable)
      .set({
        decisions: sql`${suggestionTable.decisions} || ${JSON.stringify([decision])}::jsonb`,
      })
      .where(eq(suggestionTable.id, assessmentId));
    // A member's review of an Email-to-Purchase connection protects that Email,
    // and the protecting read has one owner. The two rows share an id, so a
    // command's Feedback and its frontier name the same review.
    if (
      row.authority === "member" &&
      prediction.subject.kind === "recommendation" &&
      prediction.subject.entity === "email" &&
      prediction.subject.scope === "connection.email-purchase" &&
      !correctionAuthorityReceiptKinds.options.some(
        (kind) =>
          kind ===
          z.object({ kind: z.string() }).safeParse(row.metadata).data?.kind,
      )
    ) {
      await appendEmailReview(transactionDb, {
        id: row.id,
        family: "recommendation",
        subjectId: assessmentId,
        emailId: prediction.subject.recordId,
        originalId: null,
        checksum: null,
        operationId: row.operationId,
        verdict: row.verdict,
        correction: row.correction,
        reason: row.reason,
        evidence: row.evidence,
        intent: row.intent,
        authority: row.authority,
        actorUserId: row.actorUserId,
        subject: {
          ...prediction.subject,
          candidate: z.json().parse(prediction.candidate),
        },
        metadata: row.metadata,
      });
    }
    return { event: row, inserted: true };
  });
}
