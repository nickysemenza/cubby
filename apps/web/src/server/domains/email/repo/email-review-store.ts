import type { MailboxClassification } from "@cubby/schemas/mailbox-research";
import { suggestionCorrection } from "@cubby/schemas/suggestion";
import { and, eq } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { emailReview } from "~/server/db/retained-tables";
import { recordChange } from "~/server/generic/changes/repo/change";

type Row = typeof emailReview.$inferSelect;
type Input = Pick<
  Row,
  | "family"
  | "subjectId"
  | "emailId"
  | "originalId"
  | "checksum"
  | "operationId"
  | "verdict"
  | "intent"
  | "authority"
  | "actorUserId"
  | "subject"
> & {
  /** A carried command keeps its Feedback id as this row's id. */
  id?: string;
  correction?: z.infer<typeof suggestionCorrection>;
  classification?: MailboxClassification | null;
  reason?: string | null;
  evidence?: unknown;
  receipt?: unknown;
  metadata?: unknown;
};

const immutable = (row: {
  verdict: unknown;
  correction: unknown;
  reason: unknown;
  intent: unknown;
  authority: unknown;
  actorUserId: unknown;
  classification: unknown;
  evidence: unknown;
  receipt: unknown;
  metadata: unknown;
}) => ({
  verdict: row.verdict,
  correction: row.correction,
  reason: row.reason,
  intent: row.intent,
  authority: row.authority,
  actorUserId: row.actorUserId,
  classification: row.classification,
  evidence: row.evidence,
  receipt: row.receipt,
  metadata: row.metadata,
});

/**
 * Append one retained review; the same operation on the same handle replays and
 * a retry that changes the event refuses. The EmailReview trigger marks the
 * Email's quality, whose member review check reads this row.
 */
export async function appendEmailReviewWithInsertion(
  db: Database,
  input: Input,
): Promise<{ event: Row; inserted: boolean }> {
  const values = {
    ...input,
    correction: suggestionCorrection.parse(
      input.correction ?? { present: false },
    ),
    classification: input.classification ?? null,
    reason: input.reason ?? null,
    evidence: z
      .json()
      .nullable()
      .parse(input.evidence ?? null),
    receipt: z
      .json()
      .nullable()
      .parse(input.receipt ?? null),
    metadata: z
      .json()
      .nullable()
      .parse(input.metadata ?? null),
  };
  return withTransactionDatabase(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const [inserted] = await client
      .insert(emailReview)
      .values(values)
      .onConflictDoNothing({
        target: [emailReview.subjectId, emailReview.operationId],
      })
      .returning();
    const event =
      inserted ??
      (
        await client
          .select()
          .from(emailReview)
          .where(
            and(
              eq(emailReview.subjectId, input.subjectId),
              eq(emailReview.operationId, input.operationId),
            ),
          )
          .limit(1)
      )[0];
    if (!event) throw new Error("Email review publication returned no row");
    if (!isEqual(immutable(values), immutable(event)))
      throw new Error("Immutable Email review retry changed its event");
    if (inserted)
      await recordChange(transactionDb, {
        kind: "source",
        categories: ["email", "suggestions"],
      });
    return { event, inserted: inserted !== undefined };
  });
}

export async function appendEmailReview(db: Database, input: Input) {
  return (await appendEmailReviewWithInsertion(db, input)).event;
}
