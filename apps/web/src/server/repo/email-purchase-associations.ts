import type { EmailId } from "@cubby/schemas/identifiers";
import { asc, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  importSourceClaim,
  importSourceOrder,
  purchase,
} from "~/server/db/schema";
import { unwrapDb } from "~/server/repo/database-helpers";
import {
  emailAcceptedEvidenceSql,
  emailPurchaseAssociationsSql,
} from "~/server/repo/email-sql";

/** Review handles follow the same owned accepted-family policy as Purchase history. */
export async function readEmailAcceptedSourceOrders(
  db: Database | DrizzleTransaction,
  emailId: EmailId,
) {
  // includes-deleted: a deleted target remains retained accepted history.
  return unwrapDb(db)
    .select({
      sourceOrderId: importSourceOrder.id,
      purchaseId: purchase.shortcode,
      purchaseDeleted: sql<boolean>`${purchase.deletedAt} IS NOT NULL`,
      source: {
        kind: importSourceClaim.kind,
        externalKey: importSourceClaim.externalKey,
        checksum: importSourceOrder.checksum,
      },
    })
    .from(importSourceOrder)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .innerJoin(purchase, eq(purchase.id, importSourceOrder.purchaseId))
    .where(sql`"ImportSourceOrder"."id" IN (
      SELECT evidence."sourceOrderId" FROM "Email"
      CROSS JOIN LATERAL (${emailAcceptedEvidenceSql(true)}) evidence
      WHERE "Email"."id" = ${emailId}
    )`)
    .orderBy(asc(purchase.shortcode), asc(importSourceOrder.id));
}

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
