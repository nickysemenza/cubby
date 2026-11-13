import {
  suggestionChildHandle,
  type suggestionPublication,
  feedbackAuthority,
  feedbackEvent,
  suggestionDecision,
} from "@cubby/schemas/suggestion";
import { CORRECTION_OUTCOME_RECEIPT_KIND } from "@cubby/schemas/suggestion-correction";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { suggestionTable } from "~/server/db/retained-tables";

import {
  decisionForOperation,
  type StoredDecision,
} from "./suggestion-decisions";

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
    return { event: row, inserted: true };
  });
}

/**
 * Append new automatic Feedback to several Suggestions with one locked read
 * and one update, in input order per Suggestion. Every operation must be new:
 * a replay belongs to {@link recordFeedbackWithInsertion}.
 */
export async function recordAutomaticFeedbacks(
  db: Database,
  raws: readonly z.input<typeof feedbackEvent>[],
): Promise<StoredDecision[]> {
  const events = raws.map((raw) => feedbackEvent.parse(raw));
  if (!events.length) return [];
  if (events.some((event) => event.authority !== "automatic"))
    throw new Error("Batched Feedback records automatic authority only");
  const ids = [...new Set(events.map((event) => event.suggestionId))];
  const client = getDb(db);
  const owners = await client
    .select({ id: suggestionTable.id, decisions: suggestionTable.decisions })
    .from(suggestionTable)
    .where(inArray(suggestionTable.id, ids))
    .orderBy(suggestionTable.id)
    .for("update");
  const existing = new Map(owners.map((row) => [row.id, row.decisions]));
  const appended = new Map<string, Omit<StoredDecision, "suggestionId">[]>();
  const rows = events.map((input) => {
    const { suggestionId, ...event } = input;
    const decisions = existing.get(suggestionId);
    if (!decisions) throw new Error("Suggestion not found");
    if (
      decisionForOperation(suggestionId, decisions, input.operationId) ||
      appended
        .get(suggestionId)
        ?.some((decision) => decision.operationId === input.operationId)
    )
      throw new Error(
        `Operation ${input.operationId} already has Feedback on this Suggestion`,
      );
    const row: StoredDecision = suggestionDecision
      .extend({ suggestionId: suggestionChildHandle })
      .parse({
        ...event,
        suggestionId,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });
    const { suggestionId: _owner, ...decision } = row;
    appended.set(suggestionId, [
      ...(appended.get(suggestionId) ?? []),
      decision,
    ]);
    return row;
  });
  await client
    .update(suggestionTable)
    .set({
      decisions: sql`${suggestionTable.decisions} || CASE ${suggestionTable.id} ${sql.join(
        [...appended].map(
          ([id, decisions]) =>
            sql`WHEN ${id}::uuid THEN ${JSON.stringify(decisions)}::jsonb`,
        ),
        sql` `,
      )} END`,
    })
    .where(inArray(suggestionTable.id, [...appended.keys()]));
  return rows;
}

export type FeedbackEvent = Awaited<
  ReturnType<typeof recordFeedbackWithInsertion>
>["event"];
