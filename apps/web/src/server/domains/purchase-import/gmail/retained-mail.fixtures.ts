import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { email as emailTable, orderMail } from "~/server/db/schema";
import { readRetainedMail } from "~/server/domains/mail/repo/retained-mail";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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
