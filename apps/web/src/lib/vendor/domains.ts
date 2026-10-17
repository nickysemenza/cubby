import { getDomain } from "tldts";

/**
 * Registrable domains many unrelated merchants send from or are hosted on:
 * free mail, storefront and payment platforms, and mail relays. A match on
 * one of these never identifies a Vendor (terminology "Sender proof").
 */
export const SHARED_SENDER_DOMAINS: ReadonlySet<string> = new Set([
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
  // Storefront and payment platforms
  "bigcartel.com",
  "ecwid.com",
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

/** The registrable domain of a sender address, unless it is shared. */
export const distinctSenderDomain = (address: string): string | null => {
  const domain = getDomain(address.slice(address.lastIndexOf("@") + 1), {
    allowPrivateDomains: true,
  });
  return domain && !SHARED_SENDER_DOMAINS.has(domain) ? domain : null;
};

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
