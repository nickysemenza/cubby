import {
  parseShortcodeFor,
  type LedgerPartyId,
  type ShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  importSourceOrder,
  orderMailAttachment,
  purchase,
  vendor,
  vendorAccount,
} from "~/server/db/schema";

/** A live Purchase whose order id equals an identifier an Email prints. */
export type MailRuleCandidate = {
  purchaseId: ShortcodeFor<"purchase">;
  vendorId: VendorId;
  /**
   * Its VendorAccount is the Email owner's at the same Vendor, so recipient
   * attribution cannot change what a link writes.
   */
  ownAccount: boolean;
  /** An import already accepted a source for it, so a confirmation adds no lines. */
  importedSource: boolean;
};

/** A candidate as the claim also shows it to the coordinator. */
type MailOrderPurchase = MailRuleCandidate & {
  vendorShortcode: ShortcodeFor<"vendor">;
  orderId: string;
  date: string | null;
};

/** Every live Purchase whose order id is one of `orderIds`, printed or upper-cased. */
export async function readMailRuleCandidates(
  db: Database,
  input: { ledgerPartyId: LedgerPartyId; orderIds: readonly string[] },
): Promise<MailOrderPurchase[]> {
  const orderIds = [
    ...new Set(input.orderIds.flatMap((id) => [id, id.toUpperCase()])),
  ];
  if (!orderIds.length) return [];
  const rows = await getDb(db)
    .select({
      id: purchase.id,
      shortcode: purchase.shortcode,
      vendorId: purchase.vendorId,
      vendorShortcode: vendor.shortcode,
      orderId: purchase.orderId,
      date: purchase.date,
      accountPartyId: vendorAccount.ledgerPartyId,
      accountVendorId: vendorAccount.vendorId,
    })
    .from(purchase)
    .innerJoin(vendor, eq(vendor.id, purchase.vendorId))
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, purchase.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .where(and(inArray(purchase.orderId, orderIds), notDeleted(purchase)));
  const imported = rows.length
    ? new Set(
        (
          await getDb(db)
            .select({ purchaseId: importSourceOrder.purchaseId })
            .from(importSourceOrder)
            .where(
              inArray(
                importSourceOrder.purchaseId,
                rows.map((row) => row.id),
              ),
            )
        ).map((row) => row.purchaseId),
      )
    : new Set<string>();
  return rows.flatMap(
    ({
      id,
      shortcode,
      vendorId,
      vendorShortcode,
      orderId,
      date,
      ...account
    }) =>
      vendorId && orderId
        ? [
            {
              purchaseId: parseShortcodeFor("purchase", shortcode),
              vendorId,
              vendorShortcode: parseShortcodeFor("vendor", vendorShortcode),
              orderId,
              date,
              ownAccount:
                account.accountPartyId === input.ledgerPartyId &&
                account.accountVendorId === vendorId,
              importedSource: imported.has(id),
            },
          ]
        : [],
  );
}

/** Attachments whose retained bytes would need a purpose decision before a link. */
export async function countRetainedMailAttachments(
  db: Database,
  orderMailId: string,
) {
  const rows = await getDb(db)
    .select({ id: orderMailAttachment.id })
    .from(orderMailAttachment)
    .where(
      and(
        eq(orderMailAttachment.orderMailId, orderMailId),
        or(
          isNotNull(orderMailAttachment.imageId),
          isNotNull(orderMailAttachment.pendingObjectKey),
        ),
      ),
    );
  return rows.length;
}
