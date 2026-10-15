import {
  MAILBOX_RESEARCH_VERSION,
  type MailboxClassificationDecision,
} from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { runAfterCommit } from "~/server/db/helpers/core";
import {
  email as emailTable,
  orderMail,
  orderMailAttachment,
} from "~/server/db/schema";
import { emailMemberClassificationSql } from "~/server/domains/email/repo/email-sql";

import { hasRetainedEmailImportContent } from "../email-content";

/** Gmail ingest's own reads and writes on Email and its retained original. */

/** The member's classification override for one Email, if any. */
export async function readMemberClassification(db: Database, emailId: string) {
  const [member] = await getDb(db)
    .select({ classification: emailMemberClassificationSql() })
    .from(emailTable)
    .where(eq(emailTable.id, emailId))
    .limit(1);
  return member?.classification ?? null;
}

/** Whether an order-mail original still holds importable content. */
export async function hasRetainedOrderMailContent(
  db: Database,
  orderMailId: string,
) {
  const [original] = await getDb(db)
    .select({ content: orderMail.content })
    .from(orderMail)
    .where(eq(orderMail.id, orderMailId))
    .limit(1);
  return hasRetainedEmailImportContent(
    getDb(db),
    orderMailId,
    original?.content ?? null,
  );
}

/** A rerun that agrees with the stored verdict refreshes only its stage and reason. */
export async function confirmEmailClassification(
  db: Database,
  emailId: string,
  decision: Pick<MailboxClassificationDecision, "stage" | "reason">,
) {
  await getDb(db)
    .update(emailTable)
    .set({
      classificationStage: decision.stage,
      classificationReason: decision.reason,
      classificationVersion: MAILBOX_RESEARCH_VERSION,
      updatedAt: new Date(),
    })
    .where(eq(emailTable.id, emailId));
}

/** Object keys an order-mail original already stages; a failed publish must not delete them. */
export async function pendingAttachmentKeys(
  db: Database,
  orderMailId: string,
): Promise<string[]> {
  const rows = await getDb(db)
    .select({ key: orderMailAttachment.pendingObjectKey })
    .from(orderMailAttachment)
    .where(eq(orderMailAttachment.orderMailId, orderMailId));
  return rows.flatMap(({ key }) => (key ? [key] : []));
}

/** A republished original is retained again. */
export async function restoreOrderMailContent(
  db: Database,
  orderMailId: string,
) {
  await getDb(db)
    .update(emailTable)
    .set({ contentClearedAt: null })
    .where(eq(emailTable.orderMailId, orderMailId));
}

/** Run `effect` once the publication transaction `db` commits. */
export const afterPublicationCommit = (
  db: Database,
  effect: () => Promise<void>,
) => runAfterCommit(db, effect);
