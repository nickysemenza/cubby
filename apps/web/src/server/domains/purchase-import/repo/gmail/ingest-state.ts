import type { EmailId } from "@cubby/schemas/identifiers";
import {
  MAILBOX_RESEARCH_VERSION,
  type MailboxClassificationDecision,
} from "@cubby/schemas/mailbox-research";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, withTransaction } from "~/server/db/helpers";
import { email as emailTable, orderMail } from "~/server/db/schema";
import { emailMemberClassificationSql } from "~/server/domains/email/repo/email-sql";
import { hasRetainedEmailImportContent } from "~/server/domains/purchase-import/repo/email-content";
import { recordChange } from "~/server/generic/changes/repo/change";

/** Gmail ingest's own reads and writes on Email and its retained original. */

/** The member's classification override for one Email, if any. */
export async function readMemberClassification(db: Database, emailId: EmailId) {
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
  emailId: EmailId,
  decision: Pick<MailboxClassificationDecision, "stage" | "reason">,
) {
  await withTransaction(db, async (tx) => {
    await tx
      .update(emailTable)
      .set({
        classificationStage: decision.stage,
        classificationReason: decision.reason,
        classificationVersion: MAILBOX_RESEARCH_VERSION,
        updatedAt: new Date(),
      })
      .where(eq(emailTable.id, emailId));
    await recordChange(tx, { kind: "source", categories: ["email"] });
  });
}

/** A republished original is retained again. */
export async function restoreOrderMailContent(
  db: Database,
  orderMailId: string,
) {
  await withTransaction(db, async (tx) => {
    await tx
      .update(emailTable)
      .set({ contentClearedAt: null })
      .where(eq(emailTable.orderMailId, orderMailId));
    await recordChange(tx, { kind: "source", categories: ["email"] });
  });
}
