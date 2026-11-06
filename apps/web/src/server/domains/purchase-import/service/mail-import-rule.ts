import type { VendorId } from "@cubby/schemas/identifiers";
/** Confident unrelated outcomes and exact carrier notices bypass the coordinator.
 * Other related originals need package extraction even when their order already exists.
 */
import type {
  MailboxClassification,
  MailboxClassificationStage,
  MailEvent,
} from "@cubby/schemas/mailbox-research";

import type { MailRuleCandidate } from "../repo/mail-rule-evidence";

export const MAIL_IMPORT_RULE_REVISION = "mail-import-rule-2026-11-06.1";

type RuleLifecycleEvent = Extract<
  MailEvent,
  "confirmation" | "shipped" | "delivered"
>;

// The subject names the lifecycle state; any reversal, failure or exception
// word leaves the notice to the coordinator.
const EXCLUDED_SUBJECT =
  /\b(?:refund\w*|return\w*|cancel\w*|exchange\w*|replacement|reversal|chargeback|dispute\w*|undeliver\w*|delay\w*|attempt\w*|exception|problem|issue|fail\w*|unable|missed|lost|damaged|stopped)\b/u;
// Past-tense reversals in the body; footer policy text ("Returns are free",
// "non-refundable") names no event and does not count.
const BODY_REVERSAL =
  /\b(?:refunded|cancell?ed)\b|\brefund (?:has|have|was|were) (?:been )?(?:issued|processed|initiated|sent|credited)\b|\bissued (?:a|your) refund\b|\b(?:been|was|were|is) returned\b|\border cancell?ation\b|\b(?:return|returns) (?:has been |was )?(?:received|processed)\b|\breceived your return\b/u;
const DELIVERED =
  /\bdelivered\b|\bdelivery (?:complete|completed|confirmed|confirmation)\b/u;
const NOT_YET_DELIVERED =
  /\b(?:will be|to be|be|being|expected|estimated|scheduled|arriving|arrives|out for)\b/u;
const SHIPPED =
  /\b(?:shipped|shipping confirmation|shipment (?:confirmation|notification)|on (?:its|their|the) way|out for delivery|in transit|arriving|will be delivered)\b/u;
const CONFIRMATION =
  /\border (?:confirmation|confirmed|received|placed)\b|\bthanks?(?: you)? for (?:your )?(?:order|purchase)\b|\bwe(?:'ve| have)? received your order\b|\byour order (?:is|has been) (?:confirmed|placed|received)\b|\breceipt for your (?:order|purchase)\b/u;

const normalized = (value: string) =>
  value.toLowerCase().replaceAll("’", "'").replace(/\s+/gu, " ");

/**
 * The one lifecycle event a notice's subject names, or null when it names
 * none, several, or any reversal; a body that reports a reversal is null too.
 */
export function mailLifecycleEvent(
  subject: string | null,
  text: string,
): RuleLifecycleEvent | null {
  if (!subject) return null;
  const line = normalized(subject);
  if (EXCLUDED_SUBJECT.test(line) || BODY_REVERSAL.test(normalized(text)))
    return null;
  const events: RuleLifecycleEvent[] = [];
  if (DELIVERED.test(line) && !NOT_YET_DELIVERED.test(line))
    events.push("delivered");
  if (SHIPPED.test(line)) events.push("shipped");
  if (CONFIRMATION.test(line)) events.push("confirmation");
  return events.length === 1 ? events[0]! : null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function statedDay(month: string, day: string, year: string) {
  const index = MONTHS.indexOf(month.toLowerCase());
  if (index < 0) return null;
  const value = `${year}-${String(index + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return parsed.getUTCMonth() === index && parsed.getUTCDate() === Number(day)
    ? value
    : null;
}

const USPS_SENDER = /@(?:[a-z0-9-]+\.)*usps\.(?:com|gov)>?$/iu;
const FEDEX_SENDER = /@(?:[a-z0-9-]+\.)*fedex\.com>?$/iu;
const USPS_EXPECTED =
  /^USPS® Expected Delivery (?:on|by) [A-Za-z]+, ([A-Za-z]+) (\d{1,2}), (\d{4}) (?:arriving by \d{1,2}:\d{2}[ap]m|Between \d{1,2}:\d{2}[ap]m and \d{1,2}:\d{2}[ap]m) (\d{20,34})$/u;
const FEDEX_ON_THE_WAY = /^Your shipment is on the way (\d{12,15})$/u;
const FEDEX_TOMORROW =
  /^Your shipment is scheduled for delivery tomorrow (\d{12,15})$/u;

export type CarrierNotice = {
  carrierName: "USPS" | "FedEx";
  trackingNumber: string;
  rawStatus: string;
  kind: "in_transit" | "unknown";
  day: string;
  timeBasis: "notification_received" | "estimate";
};

/**
 * The package a carrier's own notice states, when its subject is one exact known
 * wording and the body repeats the tracking number. Anything else returns null
 * and goes to the coordinator; a forecast never asserts delivery.
 */
export function carrierNotice(evidence: {
  sender: string | null;
  subject: string | null;
  text: string;
  notificationDay: string | null;
}): CarrierNotice | null {
  const { sender, notificationDay } = evidence;
  const subject = evidence.subject?.trim();
  if (!sender || !subject || !notificationDay) return null;
  const inBody = (number: string) =>
    evidence.text.replaceAll(/\s/gu, "").includes(number);
  if (USPS_SENDER.test(sender.trim())) {
    const match = USPS_EXPECTED.exec(subject);
    if (!match) return null;
    const [, month, day, year, trackingNumber] = match;
    const stated = statedDay(month!, day!, year!);
    if (!stated || !inBody(trackingNumber!)) return null;
    return {
      carrierName: "USPS",
      trackingNumber: trackingNumber!,
      rawStatus: subject,
      kind: "unknown",
      day: stated,
      timeBasis: "estimate",
    };
  }
  if (!FEDEX_SENDER.test(sender.trim())) return null;
  const moving = FEDEX_ON_THE_WAY.exec(subject);
  const forecast = FEDEX_TOMORROW.exec(subject);
  const trackingNumber = moving?.[1] ?? forecast?.[1];
  if (!trackingNumber || !inBody(trackingNumber)) return null;
  return {
    carrierName: "FedEx",
    trackingNumber,
    rawStatus: subject,
    kind: moving ? "in_transit" : "unknown",
    day: notificationDay,
    timeBasis: "notification_received",
  };
}

export type MailRuleEvidence = {
  subject: string | null;
  /** The compact body the coordinator would read first. */
  text: string;
  classification: MailboxClassification | null;
  classificationStage: MailboxClassificationStage | null;
  /** The member selected this Run's Emails themselves. */
  memberSelected: boolean;
  /** The Vendor the sender proves (terminology "Sender proof"). */
  senderVendorId: VendorId | null;
  /** Attachments with retained bytes, whose purpose only a model decides. */
  retainedAttachments: number;
  candidates: readonly MailRuleCandidate[];
  carrierNotice?: CarrierNotice | null;
};

type MailRuleDecision =
  | { kind: "unrelated"; reason: string }
  | { kind: "package_notice"; notice: CarrierNotice }
  | { kind: "coordinator"; reason: string };

// The classifier answers `unrelated` only when confident; abstention is `uncertain`.
const CLASSIFIER_STAGES: ReadonlySet<MailboxClassificationStage> = new Set([
  "rule",
  "decision",
  "model",
]);

export function decideMailByRule(evidence: MailRuleEvidence): MailRuleDecision {
  if (evidence.retainedAttachments > 0)
    return {
      kind: "coordinator",
      reason: "Attachment purposes need a decision.",
    };
  if (
    EXCLUDED_SUBJECT.test(normalized(evidence.subject ?? "")) ||
    BODY_REVERSAL.test(normalized(evidence.text))
  )
    return {
      kind: "coordinator",
      reason: "A reversal or lifecycle exception needs a decision.",
    };
  const event = mailLifecycleEvent(evidence.subject, evidence.text);
  if (
    evidence.classification === "unrelated" &&
    evidence.classificationStage &&
    CLASSIFIER_STAGES.has(evidence.classificationStage)
  ) {
    if (evidence.memberSelected)
      return {
        kind: "coordinator",
        reason: "The member selected this Email despite its classification.",
      };
    if (event || evidence.candidates.length)
      return {
        kind: "coordinator",
        reason: "An unrelated classification names a recorded order.",
      };
    // A known order sender's receipt can be image-only or oddly formatted,
    // which the classifier may misread; only the coordinator closes it.
    if (evidence.senderVendorId)
      return {
        kind: "coordinator",
        reason: "An unrelated classification of a known Vendor's Email.",
      };
    return {
      kind: "unrelated",
      reason: `The ${evidence.classificationStage} classifier confidently classified this Email unrelated.`,
    };
  }
  if (evidence.carrierNotice && evidence.classification === "related")
    return { kind: "package_notice", notice: evidence.carrierNotice };
  // Association alone cannot establish that package evidence was extracted.
  return {
    kind: "coordinator",
    reason: "Related Email needs source and package extraction.",
  };
}
