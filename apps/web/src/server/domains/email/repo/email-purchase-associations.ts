import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import type { EmailId } from "@cubby/schemas/identifiers";
import { asc, eq, sql } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { type RepositoryQueryTransaction as DrizzleTransaction } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";
import {
  importSourceClaim,
  importSourceOrder,
  purchase,
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
