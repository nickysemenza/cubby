import { wasm } from "~/server/wasm";

/**
 * Deterministic relevance verdicts for mail that is never household purchase
 * evidence. They run before any model call and only ever decide `unrelated`.
 * Only a definitive sender settles unconditionally; subject-shaped rules defer
 * to the models whenever the subject or body shows purchase-outcome evidence.
 */

/** Exact marketing-only addresses with no purchase history in the mailbox.
 * Merchants that send receipts from the same address (for example CB2's
 * `mail.` sender) must not be listed: an address rule cannot see the body. */
const PROMOTIONAL_SENDERS = new Set([
  "americanexpress@member.americanexpress.com",
  "bevmo@bevmo.com",
  "ebaygreenteam@email.greenteam.ebay.com",
  "email.campaign@sg.booking.com",
  "hi@saltandstone.com",
  "listings@redfin.com",
  "officedepot@em.officedepot.com",
]);

const PRE_PURCHASE = /\b(?:quotes?|estimates?|bids?|outbid|proposal)\b/iu;
const ABANDONED_CART =
  /\b(?:left (?:an item|items|something) in your cart|still in your cart|your cart is waiting)\b/iu;
// A subject saying a quote or bid became a purchase keeps the model in charge.
const PURCHASE_OUTCOME =
  /\b(?:order(?:ed)?|receipt|invoice|paid|payment|purchased?|confirm(?:ed|ation)?|shipped|shipping|deliver(?:y|ed)?|won)\b/iu;
// Phrases confirming that money or an order changed hands, matched against
// whitespace-collapsed readable text. Deliberately broad: a miss drops evidence.
const OUTCOME_EVIDENCE =
  /\b(?:refund(?:ed|s)?|receipt|invoice|paid in full|amount paid|total paid|(?:order|payment|deposit|purchase) (?:confirmed|placed|received|processed|completed?|number|paid)|(?:received|processed|confirmed|accepted) your (?:order|payment|deposit|purchase)|thank you for your (?:order|purchase|payment|deposit)|(?:has|have) been (?:paid|charged)|you(?:'|\u2019)ve been charged)\b/iu;
const PAYOUT =
  /\b(?:payouts?|you(?:'|’)ve been paid|funds (?:are )?(?:now )?available)\b/iu;

type Sender = {
  address: string;
  domain: string;
  subject: string;
  /** The subject or body shows purchase-outcome evidence. */
  outcome: boolean;
};

const within = (domain: string, suffix: string) =>
  domain === suffix || domain.endsWith(`.${suffix}`);

const RULES: readonly { reason: string; matches: (mail: Sender) => boolean }[] =
  [
    {
      reason:
        "USPS Informed Delivery digests carry no merchant purchase evidence",
      matches: ({ domain }) => within(domain, "informeddelivery.usps.com"),
    },
    {
      reason: "Person-to-person payments are not purchase evidence",
      matches: ({ address, domain }) =>
        within(domain, "venmo.com") ||
        within(domain, "cash.app") ||
        address === "cash@square.com",
    },
    {
      reason: "The sender sends only promotional mail",
      matches: ({ address }) => PROMOTIONAL_SENDERS.has(address),
    },
    {
      reason: "eBay member messages are conversations, not order evidence",
      matches: ({ domain, subject, outcome }) =>
        !outcome &&
        (within(domain, "members.ebay.com") ||
          (within(domain, "ebay.com") &&
            /\bsent a message about\b/iu.test(subject))),
    },
    {
      reason: "Payouts and seller statements record sales, not purchases",
      matches: ({ domain, subject, outcome }) =>
        !outcome &&
        (PAYOUT.test(subject) ||
          (within(domain, "ebay.com") &&
            /\bstatement summary\b/iu.test(subject))),
    },
    {
      reason: "Quotes, estimates, bids and cart reminders precede a purchase",
      matches: ({ subject, outcome }) =>
        !outcome &&
        (PRE_PURCHASE.test(subject) || ABANDONED_CART.test(subject)) &&
        !PURCHASE_OUTCOME.test(subject),
    },
  ];

/** The rule reason for mail that is never purchase evidence, or null. */
export function mailRelevanceRule(mail: {
  headers: Readonly<Record<string, string>>;
  bodyText: string | null;
  bodyHtml: string | null;
}): string | null {
  const from = mail.headers.from ?? "";
  // The mailbox is the last angle-bracketed address; a quoted display name
  // may contain another one.
  const address = ([...from.matchAll(/<([^<>]+)>/gu)].at(-1)?.[1] ?? from)
    .trim()
    .toLowerCase();
  const subject = mail.headers.subject ?? "";
  // The compactor decodes entities and flattens markup; collapsing whitespace
  // lets phrases split by tags or line breaks still match.
  const readable = (text: string) => text.replace(/\s+/gu, " ");
  const body = readable(
    `${mail.bodyText ?? ""} ${mail.bodyHtml ? wasm.compact_email_html(mail.bodyHtml).text : ""}`,
  );
  const sender = {
    address,
    domain: address.split("@")[1] ?? "",
    subject,
    outcome:
      OUTCOME_EVIDENCE.test(readable(subject)) || OUTCOME_EVIDENCE.test(body),
  };
  return RULES.find((rule) => rule.matches(sender))?.reason ?? null;
}
