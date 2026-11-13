import {acceptedOrderPurchasesSql} from "~/server/domains/purchase-import/repo/accepted-order-read";
import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import type { EmailId } from "@cubby/schemas/identifiers";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import {
  importSourceClaim,
  importSourceOrder,
  purchase,
  sourceOrderObservation,
} from "~/server/db/retained-tables";
import {
  emailAcceptedEvidenceSql,
  emailPurchaseAssociationsSql,
} from "~/server/domains/email/repo/email-sql";

const KIND = emailLinkEvidenceKind.enum;

/** Review handles follow the same owned accepted-family policy as Purchase history. */
export async function readEmailAcceptedSourceOrders(
  db: Database | DrizzleTransaction,
  emailId: EmailId,
) {
  // includes-deleted: accepted evidence retains its target's identity.
  return unwrapDb(db).select({sourceOrderId:sourceOrderObservation.id,purchaseId:purchase.shortcode,
    purchaseDeleted:sql<boolean>`${purchase.id} IS NULL OR ${purchase.deletedAt} IS NOT NULL`,
    source:{kind:sourceOrderObservation.sourceKind,externalKey:sourceOrderObservation.sourceExternalKey,checksum:sourceOrderObservation.checksum}})
    .from(sourceOrderObservation).leftJoin(purchase,sql`${purchase.id} = (
      SELECT accepted."boundPurchaseId"::uuid FROM ${acceptedOrderPurchasesSql} accepted WHERE accepted.id=${sourceOrderObservation.id})`)
    .where(eq(sourceOrderObservation.emailId,emailId)).orderBy(asc(purchase.shortcode),asc(sourceOrderObservation.id));
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
      // An accepted import source outranks a reviewed lifecycle link.
      kind: sql<"accepted" | "linked">`CASE WHEN "Purchase"."id" IN (
        SELECT accepted."purchaseId" FROM "Email"
        CROSS JOIN LATERAL (${emailAcceptedEvidenceSql(true)}) accepted
        WHERE "Email"."id" = ${emailId}
      ) THEN ${KIND.accepted}::text ELSE ${KIND.linked}::text END`,
    })
    .from(purchase)
    .where(sql`"Purchase"."id" IN (
      SELECT association."purchaseId" FROM "Email"
      CROSS JOIN LATERAL (${emailPurchaseAssociationsSql(true)}) association
      WHERE "Email"."id" = ${emailId}
    )`)
    .orderBy(asc(purchase.shortcode));
}
