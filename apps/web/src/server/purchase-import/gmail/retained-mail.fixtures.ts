import type { Database } from "~/server/db";
import { email as emailTable, orderMail } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { readRetainedMail } from "~/server/repo/retained-mail";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

type RetainedMailFixtureInput = typeof orderMail.$inferInsert &
  Pick<
    typeof emailTable.$inferInsert,
    | "mailboxId"
    | "messageId"
    | "threadId"
    | "historyId"
    | "sender"
    | "subject"
    | "receivedAt"
  >;

/** Persist the content shell and its unique Email owner without granting import authority. */
export async function syntheticRetainedMail(
  db: Database,
  input: RetainedMailFixtureInput,
) {
  const {
    mailboxId,
    messageId,
    threadId,
    historyId,
    sender,
    subject,
    receivedAt,
    ...remaining
  } = input;
  const [shell] = await getDb(db)
    .insert(orderMail)
    .values(remaining)
    .returning();
  if (!shell) throw new Error("Synthetic retained shell missing");
  await insertWithShortcode(db, "email", {
    ledgerPartyId: shell.ledgerPartyId,
    provider: "gmail",
    mailboxId,
    messageId,
    threadId,
    historyId,
    sender,
    subject,
    receivedAt,
    orderMailId: shell.id,
    checksum: shell.rawChecksum,
    status: "pending",
    executionPolicy: "classification_only",
  });
  const [source] = await readRetainedMail(db, {
    ledgerPartyIds: [shell.ledgerPartyId],
    orderMailIds: [shell.id],
  });
  if (!source) throw new Error("Synthetic retained Email missing");
  return source;
}
