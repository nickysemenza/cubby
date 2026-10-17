/**
 * Producer of the mail financial event port: declared inference on one exact
 * retained original, then host verification that every reported value is
 * copied from it. Forwarded or otherwise unattributed evidence never prepares
 * an event; the finance writer owns booking and convergence.
 */
import type { ActorContext } from "@cubby/schemas/context";
import {
  financialMailEvent,
  type FinancialMailEvent,
} from "@cubby/schemas/financial-mail-event";
import type { EmailId } from "@cubby/schemas/identifiers";
import type { MailFinancialEventModelOutput } from "@cubby/schemas/mailbox-research";

import { currencyMinorDigits } from "~/lib/number-format";
import type { DecisionPort } from "~/server/ai/decision-model";
import { MAIL_FINANCIAL_EVENT_FEATURE } from "~/server/ai/policy/features";
import {
  runStructuredFeature,
  type AiChatRequest,
  type AiRunContext,
} from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import {
  mailEvidenceContains,
  mailEvidenceText,
  mintPreparedMailFinancialEvent,
  readMailFinancialSource,
  type PreparedMailFinancialEvent,
} from "~/server/domains/purchase-import/repo/mail-financial-event";
import {
  aiCallRunInput,
  ensureRun,
} from "~/server/domains/run/repo/ensure-run";

import {
  judgeMailAttributions,
  mailJudgmentEvidence,
} from "./mail-source-judgment";

export type MailFinancialEventPorts = {
  decide?: DecisionPort;
  extract?: (
    request: AiChatRequest,
    usage: AiRunContext,
  ) => Promise<MailFinancialEventModelOutput>;
};

/**
 * Minor units from a copied amount. Grouping and decimal marks are read both
 * ways; a literal whose two readings differ leaves the event unverified.
 */
export function literalAmountMinor(text: string, currency: string) {
  const digits = currencyMinorDigits(currency);
  const numbers = text.match(/\d[\d.,\s]*\d|\d/gu) ?? [];
  if (numbers.length !== 1 || !numbers[0]) return null;
  const number = numbers[0].replace(/\s/gu, "");
  const values = new Set<number>();
  for (const [group, decimal] of [
    [",", "."],
    [".", ","],
  ] as const) {
    const [whole = "", fraction = "", extra] = number.split(decimal);
    if (extra !== undefined || fraction.length > digits) continue;
    const grouped = whole.split(group);
    if (
      grouped.length > 1 &&
      !grouped.every((part, index) =>
        index === 0 ? /^\d{1,3}$/u.test(part) : /^\d{3}$/u.test(part),
      )
    )
      continue;
    values.add(
      Number(grouped.join("")) * 10 ** digits +
        Number(fraction.padEnd(digits, "0") || 0),
    );
  }
  const [minor] = values;
  return values.size === 1 && minor && Number.isSafeInteger(minor)
    ? minor
    : null;
}

const isoDate = (text: string | null) =>
  text && /^\d{4}-\d{2}-\d{2}$/u.test(text.trim()) ? text.trim() : null;

/** Outside the booking transaction: declared decisions, then literal verification. */
export async function prepareMailFinancialEvent(
  db: Database,
  input: { emailId: EmailId },
  actor: ActorContext,
  ports: MailFinancialEventPorts = {},
): Promise<
  | { status: "verified"; preparation: PreparedMailFinancialEvent }
  | { status: "unverified"; reason: string }
> {
  const source = await readMailFinancialSource(db, input.emailId, actor);
  if (!source)
    return {
      status: "unverified",
      reason: "The Email is not a retained, related original of this member.",
    };
  const { mail } = source;
  const usage: AiRunContext = {
    db,
    runId: await ensureRun(db, actor, aiCallRunInput(actor)),
    operation: "mail-financial-event",
  };
  const [attribution] = await judgeMailAttributions(
    [mail],
    usage,
    ports.decide,
  );
  if (attribution !== "recipient")
    return {
      status: "unverified",
      reason: `The Email's transaction is not attributed to its recipient (${attribution ?? "uncertain"}); a forwarded copy alone never proves ownership.`,
    };
  const request = MAIL_FINANCIAL_EVENT_FEATURE.request(
    JSON.stringify(mailJudgmentEvidence(mail)),
  );
  const output = ports.extract
    ? await ports.extract(request, usage)
    : await runStructuredFeature(MAIL_FINANCIAL_EVENT_FEATURE, request, usage);
  if (output.kind === "none" || output.confidence !== "high")
    return {
      status: "unverified",
      reason: "The Email does not confidently confirm one financial event.",
    };
  const corpus = mailEvidenceText(mail.content);
  const copied = [
    output.amountText,
    output.providerEventId,
    output.sourceAccountLabel,
    output.counterpartyLabel,
    output.occurredOn,
  ].filter((value): value is string => value !== null);
  const missing = copied.find((value) => !mailEvidenceContains(corpus, value));
  if (missing !== undefined)
    return {
      status: "unverified",
      reason: `A reported value is not in the original: ${missing}`,
    };
  const minor =
    output.amountText && output.currency
      ? literalAmountMinor(output.amountText, output.currency)
      : null;
  if (!minor || !output.currency)
    return {
      status: "unverified",
      reason: "The Email's amount or currency is missing or ambiguous.",
    };
  const event: FinancialMailEvent = financialMailEvent.parse({
    kind: output.kind,
    amount: { minor, currency: output.currency },
    sourceAccountLabel: output.sourceAccountLabel?.trim() || null,
    providerEventId: output.providerEventId?.trim() || null,
    occurredOn: isoDate(output.occurredOn),
    counterpartyLabel: output.counterpartyLabel?.trim() || null,
  });
  return {
    status: "verified",
    preparation: mintPreparedMailFinancialEvent({
      event,
      emailId: input.emailId,
      checksum: mail.rawChecksum,
      literals: copied,
    }),
  };
}
