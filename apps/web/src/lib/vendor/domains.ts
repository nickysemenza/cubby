import { GENERIC_SENDER_ADDRESSES } from "@cubby/schemas/vendor-import-fields";
import { getDomain } from "tldts";

/** The bare address from a From header, without its display name. */
export const senderAddress = (sender: string | null): string | null => {
  const address = (/<([^>]+)>/u.exec(sender ?? "")?.[1] ?? sender ?? "")
    .trim()
    .toLowerCase();
  return address.includes("@") ? address : null;
};

/** Delivery and commerce platforms whose addresses can represent unrelated sellers. */
export const SHARED_PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
  // Mail relays and campaign senders
  "amazonses.com",
  "campaign-archive.com",
  "constantcontact.com",
  "convertkit.com",
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
  "bigcartel.com",
  "ecwid.com",
  "order.online",
  "paypal.com",
  "shopify.com",
  "shopifyemail.com",
  "square.site",
  "squarespace.com",
  "squareup.com",
  "stripe.com",
  "wix.com",
  "wixsite.com",
]);

/**
 * Registrable domains many unrelated merchants send from or are hosted on:
 * free mail, storefront and payment platforms, and mail relays. A match on
 * one of these never identifies a Vendor (terminology "Sender proof").
 */
export const SHARED_SENDER_DOMAINS: ReadonlySet<string> = new Set([
  // Free mail
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
  "proton.me",
  "protonmail.com",
  "yahoo.com",
  ...SHARED_PLATFORM_DOMAINS,
]);

/** The registrable domain of a sender address, unless it is shared. */
export const distinctSenderDomain = (address: string): string | null => {
  const domain = getDomain(address.slice(address.lastIndexOf("@") + 1), {
    allowPrivateDomains: true,
  });
  return domain && !SHARED_SENDER_DOMAINS.has(domain) ? domain : null;
};

/** These provider-wide endpoints cannot become exclusive seller identities. */
export const broadcastSender = (address: string): boolean =>
  GENERIC_SENDER_ADDRESSES.has(address.trim().toLowerCase());

export const vendorWebsiteDomain = (website: string | null): string | null => {
  if (!website) return null;
  try {
    const url = new URL(website);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return getDomain(url.hostname, { allowPrivateDomains: true });
  } catch {
    return null;
  }
};
