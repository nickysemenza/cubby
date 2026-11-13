import {
  mailReclassificationCheckpoint,
  mailReclassificationRead,
} from "@cubby/schemas/email-actions";
import {
  runShortcode,
  type LedgerPartyId,
  type UserId,
} from "@cubby/schemas/identifiers";
import { mailReclassifyRunInput } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  email,
  emailClassificationObservation,
  run,
} from "~/server/db/retained-tables";

/** Recovery reads only retained Run evidence and identity columns, never entity quality hydration. */
export async function loadMailReclassificationRead(
  db: Database,
  publicId: string,
  owner: { userId: UserId; ledgerPartyId: LedgerPartyId } | null,
) {
  const database = getDb(db);
  const [row] = await database
    .select({
      id: run.id,
      purpose: run.purpose,
      input: run.input,
      progress: run.progress,
      notes: run.notes,
      actorUserId: run.actorUserId,
      ledgerPartyId: run.ledgerPartyId,
    })
    .from(run)
    .where(
      and(eq(run.shortcode, runShortcode.parse(publicId)), notDeleted(run)),
    )
    .limit(1);
  if (row?.purpose !== "background" && row?.purpose !== "mail_reclassify")
    return null;
  const parsed = mailReclassifyRunInput.safeParse(row.input);
  if (!parsed.success || parsed.data.mode !== "relevance") return null;
  if (
    !owner ||
    row.actorUserId !== owner.userId ||
    row.ledgerPartyId !== owner.ledgerPartyId
  )
    throw new Error("Reclassification Run does not belong to this member");
  const input = parsed.data;
  const [identities, observations] = await Promise.all([
    // includes-deleted: a retained receipt still refers to its original Email identity.
    database
      .select({ id: email.id, shortcode: email.shortcode })
      .from(email)
      .where(
        and(
          inArray(
            email.id,
            input.emails.map((item) => item.emailId),
          ),
          eq(email.ledgerPartyId, owner.ledgerPartyId),
        ),
      ),
    database
      .select({
        emailId: emailClassificationObservation.emailId,
        checksum: emailClassificationObservation.checksum,
        classification: emailClassificationObservation.classification,
        stage: emailClassificationObservation.stage,
        reason: emailClassificationObservation.reason,
        classificationVersion:
          emailClassificationObservation.classificationVersion,
        model: emailClassificationObservation.model,
        promptVersion: emailClassificationObservation.promptVersion,
        operation: emailClassificationObservation.operation,
        provenance: emailClassificationObservation.provenance,
        conflict: emailClassificationObservation.conflict,
        createdAt: emailClassificationObservation.createdAt,
      })
      .from(emailClassificationObservation)
      .where(eq(emailClassificationObservation.runId, row.id))
      .orderBy(
        asc(emailClassificationObservation.createdAt),
        asc(emailClassificationObservation.id),
      ),
  ]);
  const codes = new Map(identities.map((item) => [item.id, item.shortcode]));
  const checkpoint = mailReclassificationCheckpoint.safeParse(row.progress);
  const continuations = await getDb(db)
    .select({ shortcode: run.shortcode })
    .from(run)
    .where(
      and(
        eq(run.parentRunId, row.id),
        eq(run.purpose, "mail_reclassify"),
        eq(run.actorUserId, owner.userId),
        eq(run.ledgerPartyId, owner.ledgerPartyId),
        notDeleted(run),
      ),
    )
    .orderBy(asc(run.createdAt), asc(run.id));
  return mailReclassificationRead.parse({
    selectedEmails: input.emails.map((item) => ({
      id: codes.get(item.emailId) ?? null,
      checksum: item.checksum,
    })),
    receipts: checkpoint.success ? checkpoint.data : null,
    continuationRuns: continuations.map((item) => item.shortcode),
    notes: row.notes,
    classificationObservations: observations.map(
      ({ emailId, createdAt, ...observation }) => ({
        ...observation,
        id: codes.get(emailId) ?? null,
        createdAt: createdAt.toISOString(),
      }),
    ),
  });
}
