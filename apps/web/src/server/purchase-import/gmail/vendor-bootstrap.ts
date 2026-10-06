import { and, sql } from "drizzle-orm";
import { getDomain } from "tldts";

import type { Database } from "~/server/db";
import { vendor } from "~/server/db/schema";
import { isUniqueViolation } from "~/server/errors/db-errors";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/**
 * Domains many unrelated merchants send from. A Vendor keyed on one would
 * claim every merchant's mail, so their senders stay `unclassified_vendor`
 * findings for the member to resolve.
 */
const SHARED_SENDER_DOMAINS = new Set([
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "me.com",
  "outlook.com",
  "paypal.com",
  "proton.me",
  "protonmail.com",
  "shopify.com",
  "shopifyemail.com",
  "square.site",
  "squarespace.com",
  "squareup.com",
  "stripe.com",
  "wix.com",
  "wixsite.com",
  "yahoo.com",
]);

/** Display names that name a mailbox, not a merchant. */
const GENERIC_DISPLAY_NAME =
  /^(?:customer (?:care|service|support)|info|no-?reply|notifications?|orders?|receipts?|sales|shop|store|support|team)$/iu;

/** Only mail that reads like an order goes to the classifier from an unknown sender. */
const ORDER_SUBJECT =
  /\b(?:order|receipt|purchase|invoice|confirm(?:ed|ation)?|thank(?:s| you) for)\b/iu;

export type SenderVendorCandidate = { name: string; domain: string };

/**
 * The Vendor an unknown sender's order mail would create, or null when the
 * sender cannot safely name one: an unparseable address, a shared mailbox
 * domain, a display name carrying an address (an impersonation shape), or a
 * subject that does not read like an order.
 */
export function senderVendorCandidate(
  sender: string,
  subject: string,
): SenderVendorCandidate | null {
  if (!ORDER_SUBJECT.test(subject)) return null;
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s@]+@[^<>\s@]+)>\s*$/u.exec(
    sender,
  );
  const address = (match?.[2] ?? sender.trim()).toLowerCase();
  if (!/^[^<>\s@]+@[^<>\s@]+$/u.test(address)) return null;
  const display = match?.[1]?.trim() ?? "";
  if (display.includes("@")) return null;
  const domain = getDomain(address.slice(address.lastIndexOf("@") + 1), {
    allowPrivateDomains: true,
  });
  if (!domain || SHARED_SENDER_DOMAINS.has(domain)) return null;
  const label = domain.split(".")[0] ?? domain;
  const name =
    display && !GENERIC_DISPLAY_NAME.test(display)
      ? display
      : label.charAt(0).toUpperCase() + label.slice(1);
  return { name, domain };
}

/**
 * Create the Vendor for a first order from a new website, keyed on its
 * registrable domain so later mail from any of its addresses matches. A name
 * another live Vendor already holds returns null: the same name on a
 * different domain is for the member to reconcile, not to merge.
 */
export async function createVendorFromOrderMail(
  db: Database,
  candidate: SenderVendorCandidate,
  sender: string,
) {
  const [taken] = await getDb(db)
    .select({ id: vendor.id })
    .from(vendor)
    .where(
      and(
        sql`lower(${vendor.name}) = lower(${candidate.name})`,
        notDeleted(vendor),
      ),
    )
    .limit(1);
  if (taken) return null;
  try {
    return await insertWithShortcode(db, "vendor", {
      name: candidate.name,
      website: `https://${candidate.domain}`,
      notes: `Created from order mail sent by ${sender}.`,
    });
  } catch (error) {
    if (isUniqueViolation(error, "Vendor_name_key")) return null;
    throw error;
  }
}
