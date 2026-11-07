import {
  parseShortcodeFor,
  type LedgerPartyId,
  type ShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  expense,
  product,
  importSourceOrder,
  orderMailAttachment,
  purchase,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ProductHit,
} from "~/server/domains/product/repo/find-by-external-ids";
import { lookupProductIdentifierSources } from "~/server/domains/product/repo/product-identifier-source";
import { wasm } from "~/server/wasm";

import { amazonAsin, lineIdentifierRequests } from "./writer";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_/-]{2,39}$/u;

/** Order, invoice or tracking identifiers the Email prints (`purchase_cues`). */
export function orderIdentifiers(subject: string | null, text: string) {
  const { cues } = wasm.purchase_cues(`${subject ?? ""}\n${text}`);
  return [
    ...new Set(cues.filter((cue) => IDENTIFIER.test(cue) && /\d/u.test(cue))),
  ];
}

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
  acceptedSourceFingerprint?: string;
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
  const accepted = rows.length
    ? await getDb(db)
        .select({
          purchaseId: importSourceOrder.purchaseId,
          checksum: importSourceOrder.checksum,
          sourceClaimId: importSourceOrder.sourceClaimId,
          orderKey: importSourceOrder.orderKey,
        })
        .from(importSourceOrder)
        .where(
          inArray(
            importSourceOrder.purchaseId,
            rows.map((row) => row.id),
          ),
        )
    : [];
  const imported = new Set(accepted.map((row) => row.purchaseId));
  return rows.flatMap(
    ({ id, shortcode, vendorId, vendorShortcode, orderId, date, ...account }) =>
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
              acceptedSourceFingerprint: JSON.stringify(
                accepted
                  .filter((row) => row.purchaseId === id)
                  .map((row) => [row.sourceClaimId, row.orderKey, row.checksum])
                  .sort((a, b) =>
                    JSON.stringify(a).localeCompare(JSON.stringify(b)),
                  ),
              ),
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

export type MailProductEvidence = {
  candidates: Array<
    Pick<ProductHit, "name" | "brandName" | "model"> & {
      productId: ShortcodeFor<"product">;
      basis:
        | { kind: "recorded_order"; purchaseId: ShortcodeFor<"purchase"> }
        | { kind: "printed_identifier"; url: string };
    }
  >;
  omitted: boolean;
};

/** Bounded identity hints, never authority to reuse a Product or its variant. */
export async function readMailProductCandidates(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorId: VendorId | null;
    purchaseIds: readonly ShortcodeFor<"purchase">[];
    links: readonly { href: string; text: string }[];
  },
): Promise<MailProductEvidence> {
  const candidates: MailProductEvidence["candidates"] = [];
  const recorded = input.purchaseIds.length
    ? await getDb(db)
        .selectDistinct({
          productId: product.shortcode,
          name: product.name,
          brandName: productBrandNameSql(product.brandId),
          model: product.model,
          purchaseId: purchase.shortcode,
        })
        .from(expense)
        .innerJoin(product, eq(product.id, expense.productId))
        .innerJoin(purchase, eq(purchase.id, expense.purchaseId))
        .innerJoin(
          vendorAccount,
          eq(vendorAccount.id, purchase.vendorAccountId),
        )
        .where(
          and(
            inArray(purchase.shortcode, input.purchaseIds.slice(0, 5)),
            eq(vendorAccount.ledgerPartyId, input.ledgerPartyId),
            eq(vendorAccount.vendorId, purchase.vendorId),
            notDeleted(expense),
            notDeleted(product),
            notDeleted(purchase),
            notDeleted(vendorAccount),
          ),
        )
        .orderBy(product.shortcode, purchase.shortcode)
        .limit(21)
    : [];
  for (const row of recorded)
    candidates.push({
      productId: parseShortcodeFor("product", row.productId),
      name: row.name,
      brandName: row.brandName,
      model: row.model,
      basis: {
        kind: "recorded_order",
        purchaseId: parseShortcodeFor("purchase", row.purchaseId),
      },
    });
  const links = input.links.filter(
    (link) =>
      z.url().safeParse(link.href).success && amazonAsin(link.href) !== null,
  );
  if (input.vendorId && links.length) {
    const [issuer] = await lookupProductIdentifierSources(db, [
      { vendorId: input.vendorId },
    ]);
    const identifierSource = issuer?.source;
    if (identifierSource) {
      const bounded = links.slice(0, 20);
      const requests = bounded.map((link) =>
        lineIdentifierRequests(identifierSource, {
          title: link.text,
          productUrl: link.href,
        }),
      );
      const hits = await findProductsByExternalIds(db, requests.flat());
      for (const [index, pairs] of requests.entries()) {
        const url = bounded[index]?.href;
        if (!url) continue;
        for (const pair of pairs)
          for (const hit of hits.get(externalIdKey(pair)) ?? [])
            candidates.push({
              productId: parseShortcodeFor("product", hit.shortcode),
              name: hit.name,
              brandName: hit.brandName,
              model: hit.model,
              basis: { kind: "printed_identifier", url },
            });
      }
    }
  }
  const unique = [
    ...new Map(
      candidates.map((candidate) => [candidate.productId, candidate]),
    ).values(),
  ];
  return {
    candidates: unique.slice(0, 20),
    omitted: recorded.length === 21 || links.length > 20 || unique.length > 20,
  };
}
