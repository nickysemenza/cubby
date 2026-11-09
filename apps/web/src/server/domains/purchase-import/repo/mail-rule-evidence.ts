import type {
  EmailOrderKeys,
  EmailTrackingKeys,
} from "@cubby/schemas/email-fields";
import {
  parseShortcodeFor,
  type LedgerPartyId,
  type ShortcodeFor,
  type VendorId,
} from "@cubby/schemas/identifiers";
import {
  and,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  email as emailTable,
  expense,
  product,
  importSourceOrder,
  orderMailAttachment,
  purchase,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ProductHit,
} from "~/server/domains/product/repo/find-by-external-ids";
import { lookupProductIdentifierSources } from "~/server/domains/product/repo/product-identifier-source";
import { wasm } from "~/server/wasm";

import { mailReadContent } from "./gmail/read-content";
import { amazonAsin, lineIdentifierRequests } from "./writer";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_/-]{2,39}$/u;

/** An Email's exact-linking keys: order numbers and carrier tracking, kept apart. */
export type MailKeys = {
  orderKeys: EmailOrderKeys;
  trackingKeys: EmailTrackingKeys;
};
type Carrier = EmailTrackingKeys[number]["carrier"];

/**
 * An order number as keys and Purchase lookups compare it: trimmed, leading
 * `#` removed, upper-cased. Hyphens and suffixes stay, so an Amazon
 * `NNN-NNNNNNN-NNNNNNN` id or a split-shipment `-2` remains its own key.
 */
export const normalizeOrderKey = (value: string) =>
  value.trim().replace(/^#+/u, "").trim().toUpperCase();
/** `normalizeOrderKey` for a stored order id column. */
export const normalizedOrderIdSql = (column: SQLWrapper) =>
  sql<string>`upper(btrim(regexp_replace(btrim(${column}), '^#+', '')))`;

/** Shipment matching compares numbers this way (`shipment/repo/evidence.ts`). */
const normalizeTracking = (value: string) =>
  value.replaceAll(/\s/gu, "").toUpperCase();

const UPS_NUMBER = /^1Z[0-9A-Z]{16}$/u;
// USPS IMpb: 20–22 or 26 digits from 91–95, optionally behind a 420+ZIP prefix.
const USPS_NUMBER = /^(?:420\d{5}(?:\d{4})?)?(9[1-5](?:\d{18,20}|\d{24}))$/u;
const USPS_INTERNATIONAL = /^[A-Z]{2}\d{9}US$/u;
// OnTrac prints C or D followed by 14 digits.
const ONTRAC_NUMBER = /^[CD]\d{14}$/u;
const ONTRAC_IN_TEXT = /\b[CD]\d{14}\b/gu;
const FEDEX_LENGTHS = new Set([12, 15, 20, 22]);
const UPS_IN_TEXT = /\b1Z[0-9A-Z]{16}\b/giu;
const USPS_INTERNATIONAL_IN_TEXT = /\b[A-Z]{2}\d{9}US\b/gu;
// Contiguous digits, or the space-grouped form carriers print (9400 1000 ...).
const DIGITS_IN_TEXT =
  /(?<![\dA-Za-z])(?:\d{4}(?: \d{4}){2,6}(?: \d{1,4})?|\d{12,34})(?![\dA-Za-z])/gu;
const FEDEX_CONTEXT = /fedex|track|shipment|package/iu;
const TRACKING_PARAMS = new Set([
  "trknbr",
  "tracknum",
  "tracknums",
  "tracking_number",
  "trackingnumber",
  "tracknumbers",
  "tlabels",
]);

function carrierFromHost(href: string): Carrier {
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (/(?:^|\.)ups\.com$/u.test(host)) return "UPS";
    if (/(?:^|\.)fedex\.com$/u.test(host)) return "FedEx";
    if (/(?:^|\.)usps\.(?:com|gov)$/u.test(host)) return "USPS";
    if (/(?:^|\.)ontrac\.com$/u.test(host)) return "OnTrac";
  } catch {
    // SILENT: an unparseable link names no carrier.
  }
  return null;
}

/** A carrier the number's own format proves, else null. */
function carrierFromNumber(number: string): Carrier {
  if (UPS_NUMBER.test(number)) return "UPS";
  if (USPS_NUMBER.test(number) || USPS_INTERNATIONAL.test(number))
    return "USPS";
  if (ONTRAC_NUMBER.test(number)) return "OnTrac";
  return null;
}

/**
 * Carrier tracking numbers an Email prints: UPS `1Z…`, USPS IMpb and
 * international formats, FedEx 12/15/20/22 digits only beside FedEx or
 * tracking wording in a FedEx Email, and tracking-link query parameters.
 */
function trackingKeys(text: string, links: readonly string[]) {
  const found = new Map<string, Carrier>();
  const add = (raw: string, carrier: Carrier) => {
    const usps = USPS_NUMBER.exec(normalizeTracking(raw));
    const number = usps?.[1] ?? normalizeTracking(raw);
    if (!found.get(number)) found.set(number, carrier);
  };
  for (const match of text.matchAll(UPS_IN_TEXT)) add(match[0], "UPS");
  for (const match of text.matchAll(USPS_INTERNATIONAL_IN_TEXT))
    add(match[0], "USPS");
  for (const match of text.matchAll(ONTRAC_IN_TEXT)) add(match[0], "OnTrac");
  const fedexEmail =
    /fedex/iu.test(text) ||
    links.some((href) => carrierFromHost(href) === "FedEx");
  for (const match of text.matchAll(DIGITS_IN_TEXT)) {
    const number = normalizeTracking(match[0]);
    if (USPS_NUMBER.test(number)) add(number, "USPS");
    else if (
      fedexEmail &&
      FEDEX_LENGTHS.has(number.length) &&
      FEDEX_CONTEXT.test(text.slice(Math.max(0, match.index - 60), match.index))
    )
      add(number, "FedEx");
  }
  for (const href of links) {
    let params: URLSearchParams;
    try {
      params = new URL(href).searchParams;
    } catch {
      // SILENT: an unparseable link carries no tracking parameter.
      continue;
    }
    for (const [name, value] of params)
      if (TRACKING_PARAMS.has(name.toLowerCase()))
        for (const part of value.split(/[,\s]+/u)) {
          const number = normalizeTracking(part);
          if (/^[A-Z0-9]{8,40}$/u.test(number) && /\d/u.test(number))
            add(number, carrierFromHost(href) ?? carrierFromNumber(number));
        }
  }
  return [...found].map(([number, carrier]) => ({ carrier, number }));
}

const TRACKING_WORD = /\btrack(?:ing)?\b/giu;
const TRACKING_WINDOW = 48;

/**
 * Whether tracking wording precedes a reference (8+ letters and digits, with
 * a digit) that is none of the recognised keys: a carrier format Cubby does
 * not know, so a rule cannot record that package.
 */
export function hasUnrecognisedTracking(text: string, keys: EmailTrackingKeys) {
  const known = keys.map((key) => key.number);
  for (const match of text.matchAll(TRACKING_WORD)) {
    const after = text.slice(
      match.index + match[0].length,
      match.index + match[0].length + TRACKING_WINDOW,
    );
    for (const token of after.split(/[^A-Za-z0-9]+/u)) {
      const reference = token.toUpperCase();
      if (
        reference.length >= 8 &&
        /\d/u.test(reference) &&
        !known.some(
          (number) => number.includes(reference) || reference.includes(number),
        )
      )
        return true;
    }
  }
  return false;
}

/**
 * The one extractor every caller shares. Order keys are the identifiers
 * `purchase_cues` reads (order, invoice, receipt, confirmation and similar
 * cues) minus anything recognised as carrier tracking.
 */
export function extractMailKeys(input: {
  subject: string | null;
  text: string;
  links: readonly string[];
}): MailKeys {
  const body = `${input.subject ?? ""}\n${input.text}`;
  const tracking = trackingKeys(body, input.links);
  const numbers = new Set(tracking.map((key) => key.number));
  const { cues } = wasm.purchase_cues(body);
  const orderKeys = [
    ...new Set(
      cues
        .filter((cue) => IDENTIFIER.test(cue.trim()) && /\d/u.test(cue))
        .map(normalizeOrderKey)
        .filter(
          (key) =>
            key.length > 0 &&
            !numbers.has(normalizeTracking(key)) &&
            carrierFromNumber(normalizeTracking(key)) === null,
        ),
    ),
  ];
  return { orderKeys, trackingKeys: tracking };
}

/** The keys of one retained original, from the compact text its read shows. */
function retainedMailKeys(
  mail: Pick<RetainedMail, "subject" | "content">,
): MailKeys {
  const content = mailReadContent(mail.content, {});
  return extractMailKeys({
    subject: mail.subject,
    text: [content.preheader, content.bodyText].filter(Boolean).join("\n"),
    links: content.links.map((link) => link.href),
  });
}

/**
 * The Email's stored keys for this retained checksum. Missing or stale keys
 * (Emails retained before keys existed, or changed since) are computed and
 * stored here, so existing Emails backfill as they are claimed or rechecked.
 */
export async function readEmailMailKeys(
  db: Database,
  mail: Pick<RetainedMail, "id" | "subject" | "content" | "rawChecksum">,
): Promise<MailKeys> {
  const [stored] = await getDb(db)
    .select({
      orderKeys: emailTable.orderKeys,
      trackingKeys: emailTable.trackingKeys,
      checksum: emailTable.mailKeysChecksum,
    })
    .from(emailTable)
    .where(eq(emailTable.orderMailId, mail.id))
    .limit(1);
  if (
    stored?.orderKeys &&
    stored.trackingKeys &&
    stored.checksum === mail.rawChecksum
  )
    return { orderKeys: stored.orderKeys, trackingKeys: stored.trackingKeys };
  const keys = retainedMailKeys(mail);
  await getDb(db)
    .update(emailTable)
    .set({
      ...keys,
      mailKeysChecksum: mail.rawChecksum,
      // Derived keys are not an Email change: evidence recovery compares
      // `updatedAt` with the holder's unresolved outcome.
      updatedAt: sql`${emailTable.updatedAt}`,
    })
    .where(
      and(
        eq(emailTable.orderMailId, mail.id),
        eq(emailTable.checksum, mail.rawChecksum),
      ),
    );
  return keys;
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

/**
 * Every live Purchase at this Vendor whose normalized order id equals one of
 * the Email's normalized order keys. Another Vendor's equal number is never a
 * candidate.
 */
export async function readMailRuleCandidates(
  db: Database,
  input: {
    ledgerPartyId: LedgerPartyId;
    vendorId: VendorId;
    orderKeys: readonly string[];
  },
): Promise<MailOrderPurchase[]> {
  const orderKeys = [...new Set(input.orderKeys.map(normalizeOrderKey))];
  if (!orderKeys.length) return [];
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
    .where(
      and(
        eq(purchase.vendorId, input.vendorId),
        inArray(normalizedOrderIdSql(purchase.orderId), orderKeys),
        notDeleted(purchase),
      ),
    );
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
