import type {
  ProductId,
  LedgerPartyId,
  RunId,
} from "@cubby/schemas/identifiers";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { researchPurchaseContextBatch } from "@cubby/schemas/research-context";
import { purchaseOrderUrl } from "@cubby/schemas/vendor";
import {
  and,
  asc,
  eq,
  inArray,
  or,
  isNotNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  expense,
  importPreparedOrder,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  mailboxMessage,
  orderMail,
  purchase,
  product,
  run,
  vendor,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

import { loadImportSourceClaimRoots } from "./source-claim-family";

/** Same-run source associations survive replay and precede asynchronous search indexing. */
export async function loadRunPurchaseContext(
  db: Database,
  input: { runId: RunId; ledgerPartyId: LedgerPartyId },
) {
  const database = getDb(db);
  const rows = await database
    .selectDistinct({
      purchaseId: purchase.id,
      purchaseRef: purchase.shortcode,
      orderId: purchase.orderId,
      date: purchase.date,
      statedTotal: purchase.statedTotal,
      vendor: {
        vendorRef: vendor.shortcode,
        name: vendor.name,
        website: vendor.website,
      },
    })
    .from(importSourceOrder)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .innerJoin(
      purchase,
      and(eq(purchase.id, importSourceOrder.purchaseId), notDeleted(purchase)),
    )
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .where(
      and(
        eq(importSourceClaim.lastRunId, input.runId),
        eq(importSourceClaim.ledgerPartyId, input.ledgerPartyId),
      ),
    )
    .orderBy(asc(purchase.id))
    .limit(51);
  let incomplete = rows.length > 50;
  const selected = rows.slice(0, 50);
  const allLines = selected.length
    ? await database
        .select({
          purchaseId: expense.purchaseId,
          name: expense.name,
          cost: expense.cost,
          productQuantity: expense.productQuantity,
          productRef: product.shortcode,
        })
        .from(expense)
        .leftJoin(
          product,
          and(eq(product.id, expense.productId), notDeleted(product)),
        )
        .where(
          and(
            inArray(
              expense.purchaseId,
              selected.map((row) => row.purchaseId),
            ),
            notDeleted(expense),
          ),
        )
        .orderBy(asc(expense.purchaseId), asc(expense.id))
        .limit(1_001)
    : [];
  incomplete ||= allLines.length > 1_000;
  const purchases = selected.map(({ purchaseId, ...header }) => {
    const lines = allLines
      .filter((line) => line.purchaseId === purchaseId)
      .map(({ purchaseId: _purchaseId, ...line }) => line);
    incomplete ||= lines.length > 20;
    return { ...header, lines: lines.slice(0, 20) };
  });
  return researchPurchaseContextBatch.parse({ purchases, incomplete });
}

/** The purchased variant comes from accepted original evidence, independently of editable ledger labels. */
export async function loadProductPurchaseContext(
  db: Database,
  input: { productId: ProductId; ledgerPartyId: LedgerPartyId },
) {
  const database = getDb(db);
  const orders = await database
    .select({
      // Drizzle uses the first selected column to recognize a missing joined
      // row. A nullable category must not hide an existing purchase line.
      line: {
        id: expense.id,
        name: expense.name,
        url: expense.url,
        productQuantity: expense.productQuantity,
      },
      purchase,
      vendor: { name: vendor.name, website: vendor.website },
      orderUrlTemplate: vendor.orderUrlTemplate,
      source: importSourceClaim,
      association: importSourceOrder,
      originalLineIndex: importSourceProduct.lineIndex,
    })
    .from(importSourceOrder)
    .leftJoin(
      importSourceProduct,
      and(
        eq(importSourceProduct.sourceOrderId, importSourceOrder.id),
        eq(importSourceProduct.productId, input.productId),
      ),
    )
    .innerJoin(
      purchase,
      and(eq(purchase.id, importSourceOrder.purchaseId), notDeleted(purchase)),
    )
    .leftJoin(
      expense,
      and(
        eq(expense.purchaseId, purchase.id),
        eq(expense.productId, input.productId),
        notDeleted(expense),
      ),
    )
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .innerJoin(
      importSourceClaim,
      and(
        eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
        eq(importSourceClaim.ledgerPartyId, input.ledgerPartyId),
      ),
    )
    .where(or(isNotNull(expense.id), isNotNull(importSourceProduct.id)))
    .limit(30);
  const roots = await loadImportSourceClaimRoots(
    database,
    orders.map((row) => row.source),
  );
  const keys = [
    ...new Set([
      ...orders.map((row) => row.source.externalKey),
      ...[...roots.values()].map((source) => source.externalKey),
    ]),
  ];
  // A source association is not a mail_read selector. Resolve the canonical
  // owned original explicitly; missing originals remain recoverable research gaps.
  const mailKey = sql<string>`'gmail:' || ${orderMail.mailboxId} || ':' || ${orderMail.messageId}`;
  const originals = keys.length
    ? await database
        .select({
          sourceKey: mailKey,
          messageRef: orderMail.id,
          checksum: orderMail.rawChecksum,
        })
        .from(orderMail)
        .innerJoin(
          mailboxMessage,
          and(
            eq(mailboxMessage.ledgerPartyId, orderMail.ledgerPartyId),
            eq(mailboxMessage.mailboxId, orderMail.mailboxId),
            eq(mailboxMessage.messageId, orderMail.messageId),
            eq(mailboxMessage.orderMailId, orderMail.id),
            eq(mailboxMessage.checksum, orderMail.rawChecksum),
          ),
        )
        .where(
          and(
            eq(orderMail.ledgerPartyId, input.ledgerPartyId),
            inArray(mailKey, keys),
            ne(mailboxMessage.classification, "unrelated"),
            notInArray(mailboxMessage.status, ["excluded", "deleted"]),
          ),
        )
        .limit(30)
    : [];
  const prepared = keys.length
    ? await database
        .select({
          sourceKey: importPreparedOrder.sourceExternalKey,
          sourceKind: importPreparedOrder.sourceKind,
          checksum: importPreparedOrder.sourceChecksum,
          extraction: importPreparedOrder.extraction,
        })
        .from(importPreparedOrder)
        .innerJoin(
          run,
          and(
            eq(run.id, importPreparedOrder.runId),
            eq(run.ledgerPartyId, input.ledgerPartyId),
            notDeleted(run),
          ),
        )
        .where(inArray(importPreparedOrder.sourceExternalKey, keys))
    : [];
  return orders.map((row) => {
    const root = roots.get(row.source.id);
    if (!root) throw new Error("Retained Product source root is missing.");
    const original = row.association.originalOrder
      ? acceptedSourceOrder.parse(row.association.originalOrder)
      : null;
    const originalMail =
      root.kind === "mail_message"
        ? originals.find(
            (mail) =>
              mail.sourceKey === root.externalKey &&
              mail.checksum === root.checksum,
          )
        : undefined;
    return {
      originalMail: originalMail
        ? {
            messageRef: originalMail.messageRef,
            checksum: originalMail.checksum,
          }
        : null,
      orderedLine:
        row.originalLineIndex !== null
          ? (original?.extraction.candidate?.lines[row.originalLineIndex] ??
            null)
          : null,
      currentLine: row.line
        ? {
            name: row.line.name,
            url: row.line.url,
            quantity: row.line.productQuantity,
          }
        : null,
      order: {
        purchaseRef: row.purchase.shortcode,
        orderId: row.purchase.orderId,
        date: row.purchase.date,
        statedTotal: row.purchase.statedTotal,
        orderUrl: purchaseOrderUrl({
          orderUrlTemplate: row.orderUrlTemplate,
          orderId: row.purchase.orderId,
        }),
      },
      vendor: row.vendor,
      source: {
        kind: row.source.kind,
        sourceRef: row.association.id,
        externalKey: root.externalKey,
        checksum: original?.checksum ?? row.association.checksum,
        currentChecksum: root.checksum,
      },
      originalExtractions: original
        ? [original.extraction]
        : prepared
            .filter(
              (source) =>
                (source.sourceKey === row.source.externalKey ||
                  source.sourceKey === root.externalKey) &&
                source.sourceKind === row.source.kind &&
                source.checksum === row.association.checksum,
            )
            .map((source) => source.extraction),
    };
  });
}
