import { buildActorContext, systemActor } from "@cubby/schemas/context";
import { userId } from "@cubby/schemas/identifiers";
import type { MailboxClassification } from "@cubby/schemas/mailbox-research";
import { suggestionCorrection } from "@cubby/schemas/suggestion";
import { and, eq } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { type Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { emailReview } from "~/server/db/retained-tables";
import { decide, householdWrite, recordSubject } from "~/server/kernel/api";
import { jsonSnapshot } from "~/server/lib/canonical-json";

import { emailReviewsRead } from "./email-decision-sql";

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

/** One decision slot per reviewed handle and operation makes exact retries idempotent. */
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
  return householdWrite(db, async (transactionDb) => {
    const client = getDb(transactionDb);
    const [previous] = await client
      .select()
      .from(emailReviewsRead)
      .where(
        and(
          eq(emailReviewsRead.subjectId, input.subjectId),
          eq(emailReviewsRead.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (previous) {
      if (!isEqual(immutable(values), immutable(previous)))
        throw new Error("Immutable Email review retry changed its event");
      return { event: previous, inserted: false };
    }
    const subject = input.emailId
      ? recordSubject("email", input.emailId)
      : `mailOriginal:${input.originalId ?? input.subjectId}`;
    const [ref] = await decide(
      transactionDb,
      input.actorUserId
        ? buildActorContext(
            userId.parse(input.actorUserId),
            input.authority === "member" ? "web" : "system",
          )
        : systemActor(),
      [
        {
          channel: "assignment",
          kind: "set",
          subject,
          field: `review:${input.subjectId}:${input.operationId}`,
          value: jsonSnapshot.parse(values),
          scopes: input.emailId
            ? [{ kind: "emailState", key: input.emailId }]
            : [],
        },
      ],
    );
    if (!ref) throw new Error("Email review decision returned no row");
    const [event] = await client
      .select()
      .from(emailReviewsRead)
      .where(eq(emailReviewsRead.id, ref.id))
      .limit(1);
    if (!event) throw new Error("Email review decision returned no row");
    return { event, inserted: true };
  });
}

export async function appendEmailReview(db: Database, input: Input) {
  return (await appendEmailReviewWithInsertion(db, input)).event;
}
