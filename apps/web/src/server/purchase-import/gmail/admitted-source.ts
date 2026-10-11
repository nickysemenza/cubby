import type { EmailExecutionPolicy } from "@cubby/schemas/email-fields";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import { email as emailTable, ledgerParty, run } from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { readRetainedMail } from "~/server/repo/retained-mail";

/** Refresh does not transfer, repair or readmit an assigned import source. */
async function classificationRefreshDisposition(
  db: Database,
  email: typeof emailTable.$inferSelect,
) {
  if (!email.runId) return "refresh";
  const [owner] = await getDb(db)
    .select()
    .from(run)
    .where(eq(run.id, email.runId))
    .limit(1);
  if (owner?.purpose === "mail_discovery") return "refresh";
  if (
    owner?.purpose !== "mail_import" ||
    owner.ledgerPartyId !== email.ledgerPartyId
  )
    return "historical";
  const frozen = mailResearchRunInput.safeParse(owner.input);
  if (!frozen.success || !email.orderMailId) return "historical";
  const source = frozen.data.sources.find(
    (candidate) =>
      candidate.orderMailId === email.orderMailId &&
      candidate.checksum === email.checksum,
  );
  if (!source) return "historical";
  const [original] = await readRetainedMail(db, {
    ledgerPartyIds: [email.ledgerPartyId],
    mailboxId: email.mailboxId,
    messageId: email.messageId,
    orderMailIds: [source.orderMailId],
  });
  return original?.rawChecksum === source.checksum ? "frozen" : "historical";
}

export async function deferClassificationRefresh(
  db: Database,
  policy: EmailExecutionPolicy,
  email: typeof emailTable.$inferSelect | null,
) {
  if (policy !== "classification_only" || !email?.runId) return false;
  return (await classificationRefreshDisposition(db, email)) !== "refresh";
}

function emailPublicationChanged(
  current: typeof emailTable.$inferSelect | null,
  expected: typeof emailTable.$inferSelect | null,
) {
  if (!expected) return Boolean(current);
  if (!current) return true;
  const fields = [
    "id",
    "runId",
    "checksum",
    "orderMailId",
    "status",
    "classification",
    "classificationVersion",
    "classificationStage",
    "classificationReason",
  ] as const;
  return (
    fields.some((key) => current[key] !== expected[key]) ||
    current.updatedAt.getTime() !== expected.updatedAt.getTime() ||
    current.contentClearedAt?.getTime() !== expected.contentClearedAt?.getTime()
  );
}

/** Provider/model IO is complete. Admission wins before this publication boundary. */
export async function publishGmailEvidence<T>(
  db: Database,
  input: {
    ledgerPartyId: string;
    mailboxId: string;
    messageId: string;
    runId?: string;
    executionPolicy: EmailExecutionPolicy;
    expected: typeof emailTable.$inferSelect | null;
  },
  publish: (
    tx: Database,
    current: typeof emailTable.$inferSelect | null,
  ) => Promise<T>,
): Promise<T | null> {
  return withTransaction(db, async (tx) => {
    const partyId = parseEntityId("ledgerParty", input.ledgerPartyId);
    const [party] = await tx
      .select({ id: ledgerParty.id })
      .from(ledgerParty)
      .where(and(eq(ledgerParty.id, partyId), notDeleted(ledgerParty)))
      .for("no key update");
    if (!party) return null;
    const runIds = [
      ...new Set(
        [input.runId, input.expected?.runId].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ].map((id) => runEntityId.parse(id));
    if (runIds.length)
      await tx
        .select({ id: run.id })
        .from(run)
        .where(inArray(run.id, runIds))
        .orderBy(asc(run.id))
        .for("update");
    const [current] = await tx
      .select()
      .from(emailTable)
      .where(
        and(
          eq(emailTable.ledgerPartyId, partyId),
          eq(emailTable.provider, "gmail"),
          eq(emailTable.mailboxId, input.mailboxId),
          eq(emailTable.messageId, input.messageId),
          notDeleted(emailTable),
        ),
      )
      .for("update")
      .limit(1);
    if (emailPublicationChanged(current ?? null, input.expected)) return null;
    const txDb = databaseForTransaction(tx);
    if (
      await deferClassificationRefresh(
        txDb,
        input.executionPolicy,
        current ?? null,
      )
    )
      return null;
    return publish(txDb, current ?? null);
  });
}
