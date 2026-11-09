/**
 * Deterministic relevance verdicts for mail that is never household purchase
 * evidence. They run before any model call and only ever decide `unrelated`;
 * a sender or subject that also carries order evidence is left to the models.
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
// Evidence that a quote or bid became a purchase keeps the model in charge.
const PURCHASE_OUTCOME =
  /\b(?:order(?:ed)?|receipt|invoice|paid|payment|purchased?|confirm(?:ed|ation)?|shipped|shipping|deliver(?:y|ed)?|won)\b/iu;
const PAYOUT =
  /\b(?:payouts?|you(?:'|’)ve been paid|funds (?:are )?(?:now )?available)\b/iu;

type Sender = { address: string; domain: string; subject: string };

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
      reason: "eBay member messages are conversations, not order evidence",
      matches: ({ domain, subject }) =>
        within(domain, "members.ebay.com") ||
        (within(domain, "ebay.com") &&
          /\bsent a message about\b/iu.test(subject)),
    },
    {
      reason: "Person-to-person payments are not purchase evidence",
      matches: ({ address, domain }) =>
        within(domain, "venmo.com") ||
        within(domain, "cash.app") ||
        address === "cash@square.com",
    },
    {
      reason: "Payouts and seller statements record sales, not purchases",
      matches: ({ domain, subject }) =>
        PAYOUT.test(subject) ||
        (within(domain, "ebay.com") && /\bstatement summary\b/iu.test(subject)),
    },
    {
      reason: "Quotes, estimates, bids and cart reminders precede a purchase",
      matches: ({ subject }) =>
        (PRE_PURCHASE.test(subject) || ABANDONED_CART.test(subject)) &&
        !PURCHASE_OUTCOME.test(subject),
    },
    {
      reason: "The sender sends only promotional mail",
      matches: ({ address }) => PROMOTIONAL_SENDERS.has(address),
    },
  ];

/** The rule reason for a sender/subject that is never purchase evidence. */
export function mailRelevanceRule(
  headers: Readonly<Record<string, string>>,
): string | null {
  const from = headers.from ?? "";
  const address = (/<([^<>]+)>/u.exec(from)?.[1] ?? from).trim().toLowerCase();
  const sender = {
    address,
    domain: address.split("@")[1] ?? "",
    subject: headers.subject ?? "",
  };
  return RULES.find((rule) => rule.matches(sender))?.reason ?? null;
}
