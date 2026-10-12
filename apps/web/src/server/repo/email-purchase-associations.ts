import type { EmailId } from "@cubby/schemas/identifiers";
import { asc, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { purchase } from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";
import { emailPurchaseAssociationsSql } from "~/server/repo/email-sql";

/** Accepted history retains deleted targets; thread and dismissed candidates never bind. */
export async function readEmailPurchaseAssociations(
  db: Database | DrizzleTransaction,
  emailId: EmailId,
) {
  // includes-deleted: readers expose historical accepted identities with deletion status.
  return unwrapDb(db)
    .select({
      id: purchase.id,
      shortcode: purchase.shortcode,
      orderId: purchase.orderId,
      date: purchase.date,
      purchaseDeleted: sql<boolean>`${purchase.deletedAt} IS NOT NULL`,
    })
    .from(purchase)
    .where(sql`"Purchase"."id" IN (
      SELECT association."purchaseId" FROM "Email"
      CROSS JOIN LATERAL (${emailPurchaseAssociationsSql(true)}) association
      WHERE "Email"."id" = ${emailId}
    )`)
    .orderBy(asc(purchase.shortcode));
}
