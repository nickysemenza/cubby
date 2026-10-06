import { and, sql } from "drizzle-orm";
import { getDomain } from "tldts";

import type { Database } from "~/server/db";
import { vendor } from "~/server/db/schema";
import { isUniqueViolation } from "~/server/errors/db-errors";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

/**
 * Domains many unrelated merchants send from: free mail, storefront and
 * payment platforms, and email relays that rewrite `From` onto their own
 * domain. A Vendor keyed on one would claim every merchant's mail, so their
 * senders stay `unclassified_vendor` findings for the member to resolve.
 */
const SHARED_SENDER_DOMAINS = new Set([
  "amazonses.com",
  "aol.com",
  "bigcartel.com",
  "campaign-archive.com",
  "constantcontact.com",
  "convertkit.com",
  "ecwid.com",
  "hubspotemail.net",
  "klaviyomail.com",
  "mailchimpapp.com",
  "mailgun.org",
  "mandrillapp.com",
  "mcsv.net",
  "postmarkapp.com",
  "rsgsv.net",
  "sendgrid.net",
  "sendinblue.com",
  "sparkpostmail.com",
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
const ORDER_SUBJECT = /\b(?:order|receipt|purchase|invoice)\b/iu;
/** Account, list, and promotional mail that mentions orders without being one. */
const NOT_ORDER_SUBJECT =
  /%\s*off|\b(?:sale|deals?|newsletter|verify|password|sign[- ]?in|log[- ]?in|subscribing|subscribed|unsubscribe[ds]?)\b|confirm your (?:email|account|subscription)|(?:manage|update) your subscription/iu;

/** Lowercase letters and digits only, to compare a name with a domain label. */
const squash = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/gu, "");

/** Advisory-lock namespaces for mail-created Vendors: names, then domains. */
const NAME_LOCK_SPACE = 7_301;
const DOMAIN_LOCK_SPACE = 7_302;

export type SenderVendorCandidate = { name: string; domain: string };

/**
 * The Vendor an unknown sender's order mail would create, or null when the
 * sender cannot safely name one: an unparseable address, a shared mailbox
 * domain, a display name carrying an address (an impersonation shape), or a
 * subject that does not read like an order. The display name names the
 * Vendor only when it resembles the domain; otherwise a sender calling itself
 * another merchant gets the domain's own name.
 */
export function senderVendorCandidate(
  sender: string,
  subject: string,
): SenderVendorCandidate | null {
  if (!ORDER_SUBJECT.test(subject) || NOT_ORDER_SUBJECT.test(subject))
    return null;
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
  const resembles =
    squash(display).length > 0 &&
    (squash(display).includes(squash(label)) ||
      squash(label).includes(squash(display)));
  const name =
    display && resembles && !GENERIC_DISPLAY_NAME.test(display)
      ? display
      : label.charAt(0).toUpperCase() + label.slice(1);
  return { name, domain };
}

/**
 * Create the Vendor for a first order from a new website, keyed on its
 * registrable domain so later mail from any of its addresses matches. Creation
 * is serialized per domain, and a Vendor another pass already created for
 * the domain is returned instead of a twin. A name another live Vendor holds
 * returns null: the same name on a different domain is for the member to
 * reconcile, not to merge.
 */
export async function createVendorFromOrderMail(
  db: Database,
  candidate: SenderVendorCandidate,
  sender: string,
) {
  try {
    return await createUnderDomainLock(db, candidate, sender);
  } catch (error) {
    // Another domain's first order took this name concurrently: the same
    // refusal as a name already held, never a failed mail batch.
    if (isUniqueViolation(error, "Vendor_name_key")) return null;
    throw error;
  }
}

async function createUnderDomainLock(
  db: Database,
  candidate: SenderVendorCandidate,
  sender: string,
) {
  return withTransaction(db, async (tx) => {
    // The name lock serializes two domains reaching for one name (the unique
    // index is case-sensitive); the domain lock serializes two names for one
    // domain. Always name first, then domain, so the order cannot deadlock.
    // Separate namespaces (the two-key lock), so a name hash can never
    // collide with a domain hash and invert the lock order.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${NAME_LOCK_SPACE}, hashtext(${candidate.name.toLowerCase()}))`,
    );
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${DOMAIN_LOCK_SPACE}, hashtext(${candidate.domain}))`,
    );
    const sameDomain = await tx
      .select()
      .from(vendor)
      .where(
        and(
          sql`${vendor.website} ILIKE ${`%${candidate.domain}%`}`,
          notDeleted(vendor),
        ),
      );
    const existing = sameDomain.find(
      (row) => websiteDomain(row.website) === candidate.domain,
    );
    if (existing) return existing;
    const [taken] = await tx
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
    return insertWithShortcode(tx, "vendor", {
      name: candidate.name,
      website: `https://${candidate.domain}`,
      notes: `Created from order mail sent by ${sender}.`,
    });
  });
}

function websiteDomain(website: string | null) {
  if (!website) return null;
  try {
    return getDomain(new URL(website).hostname, { allowPrivateDomains: true });
  } catch {
    return null;
  }
}
