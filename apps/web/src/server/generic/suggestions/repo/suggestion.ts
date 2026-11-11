import { connectionCandidate } from "@cubby/schemas/entity-connections";
import {
  suggestionChildHandle,
  type suggestionPublication,
  feedbackAuthority,
  feedbackEvent,
  suggestionDecision,
} from "@cubby/schemas/suggestion";
import {
  CORRECTION_OUTCOME_RECEIPT_KIND,
  correctionAuthorityReceiptKinds,
} from "@cubby/schemas/suggestion-correction";
import { eq, sql, type SQL } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { suggestionTable } from "~/server/db/retained-tables";
import { appendEmailReview } from "~/server/domains/email/repo/email-review-store";

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
    .object({ kind: z.string(), commandFeedbackId: suggestionChildHandle })
    .safeParse(receipt.metadata);
  if (
    !metadata.success ||
    metadata.data.kind !== kind ||
    metadata.data.commandFeedbackId !== command.id ||
    receipt.suggestionId !== command.suggestionId ||
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
 * Suggestion carries, else null: the "applied automatically" mark.
 */
export const automaticApplicationRule = (suggestionId: SQL) => sql<
  string | null
>`(SELECT CASE WHEN f.metadata->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND} THEN 'member-correction@1'
    ELSE (f.metadata->${"rule"}->>${"key"}) || '@' || (f.metadata->${"rule"}->>${"revision"}) END
  FROM "Suggestion" owner
  CROSS JOIN LATERAL jsonb_to_recordset(owner.decisions) f(metadata jsonb, receipt jsonb, authority text, "createdAt" text, id text)
  WHERE owner.id = ${suggestionId}
    AND f.authority = ${feedbackAuthority.enum.automatic}
    AND (f.metadata->>${"kind"} = ${"assessment_application"}
      OR (f.metadata->>${"kind"} = ${CORRECTION_OUTCOME_RECEIPT_KIND} AND f.receipt->>${"status"} = ${"applied"}))
  ORDER BY f."createdAt" DESC, f.id DESC
  LIMIT 1)`;

/** The rule stamps a Suggestion's publication matched. */
export const matchedRulesOf = (data: SQL) =>
  sql<unknown>`CASE WHEN jsonb_typeof(${data}->'matchedRules') = 'array' THEN ${data}->'matchedRules' ELSE '[]'::jsonb END`;

/** Immutable evidence and the creation projection of one Suggestion. */
export type SuggestionPublication = {
  input: z.input<typeof suggestionPublication>;
  projection?: Partial<typeof suggestionTable.$inferInsert>;
};

/** Builds field evidence; suggestion-publication owns immutable publication and replay. */
export function fieldSuggestionPublication(
  projection: Omit<
    typeof suggestionTable.$inferInsert,
    "id" | "family" | "publicationKey" | "subject" | "judgment"
  > & {
    field: string;
    recordId: string;
  },
): SuggestionPublication {
  const data = z.record(z.string(), z.json()).parse(projection.data ?? {});
  const model = projection.model ?? "unknown";
  return {
    input: {
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
    },
    projection: { ...projection, data },
  };
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
  const { suggestionId, ...event } = input;
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const [prediction] = await client
      .select({
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
      .where(eq(suggestionTable.id, suggestionId))
      .for("update");
    if (!prediction) throw new Error("Suggestion not found");
    const existing = decisionForOperation(
      suggestionId,
      prediction.decisions,
      input.operationId,
    );
    if (existing) {
      const {
        id: _id,
        createdAt: _at,
        suggestionId: _owner,
        ...stored
      } = existing;
      if (!isEqual(event, stored))
        throw new Error(
          `Operation ${input.operationId} was already used for a different review; send a new operationId`,
        );
      return { event: existing, inserted: false };
    }
    const row: StoredDecision = suggestionDecision
      .extend({ suggestionId: suggestionChildHandle })
      .parse({
        ...event,
        suggestionId,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });
    const { suggestionId: _owner, ...decision } = row;
    await client
      .update(suggestionTable)
      .set({
        decisions: sql`${suggestionTable.decisions} || ${JSON.stringify([decision])}::jsonb`,
      })
      .where(eq(suggestionTable.id, suggestionId));
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
        subjectId: suggestionId,
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

export type FeedbackEvent = Awaited<
  ReturnType<typeof recordFeedbackWithInsertion>
>["event"];
