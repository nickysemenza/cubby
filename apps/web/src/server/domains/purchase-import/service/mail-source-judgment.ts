/**
 * Declared semantic judgments about one retained original: whose transaction
 * it evidences and whether a supporting original is the same purchase. Both
 * are closed Decision features over checksum-bound evidence; only a confident
 * answer counts, and neither creates records. A vendor's direct mail to the
 * mailbox owner (`mail-owner.ts`) defaults to the recipient instead.
 */
import { wasm } from "~/lib/wasm";
import {
  decisionChoiceFitsContext,
  runDecisionChoices,
  type DecisionPort,
} from "~/server/ai/decision-model";
import {
  MAIL_ATTRIBUTION_FEATURE,
  MAIL_SOURCE_RELATION_FEATURE,
} from "~/server/ai/policy/features";
import type { AiRunContext } from "~/server/ai/run-feature";
import type { RetainedMail } from "~/server/domains/mail/repo/retained-mail";

import { isOwnMail, type MailOwnerContext } from "./mail-owner";

export type MailAttribution = (typeof MAIL_ATTRIBUTION_FEATURE.choices)[number];

type JudgedMail = Pick<
  RetainedMail,
  "sender" | "subject" | "content" | "rawChecksum" | "receivedAt"
>;

// Forwarding evidence lives in addressing headers; the rest are transport noise.
const ATTRIBUTION_HEADERS = [
  "from",
  "to",
  "cc",
  "delivered-to",
  "reply-to",
  "sender",
  "x-forwarded-for",
  "x-forwarded-to",
  "x-google-original-from",
  "resent-from",
  "resent-to",
] as const;

export function mailJudgmentEvidence(mail: JudgedMail) {
  const html = mail.content.bodyHtml
    ? wasm.compact_email_html(mail.content.bodyHtml)
    : null;
  const headers = Object.fromEntries(
    ATTRIBUTION_HEADERS.flatMap((name) => {
      const value = mail.content.headers?.[name];
      return value ? [[name, value]] : [];
    }),
  );
  return {
    checksum: mail.rawChecksum,
    sender: mail.sender,
    subject: mail.subject,
    receivedAt: mail.receivedAt?.toISOString() ?? null,
    headers,
    bodyText: mail.content.bodyText,
    htmlText: html?.text ?? null,
    htmlComplete: !html?.truncated,
  };
}

/**
 * One attribution decision. `model`: the decision model's label, which
 * counts only at high confidence (otherwise uncertain). `owner_default`: own
 * mail (`isOwnMail`) is `recipient` unless the model confidently answers
 * third_party. `oversized`: the evidence exceeded the decision context, so
 * no model answered and the label is uncertain, own mail included.
 * `warnings` carry owner-evidence gaps, such as an unreadable Gmail profile.
 */
export type MailAttributionJudgment = {
  label: MailAttribution;
  basis: "owner_default" | "model" | "oversized";
  modelLabel: MailAttribution | null;
  probability: number | null;
  warnings: readonly string[];
};

/** Raw decision diagnostics for refusal messages. */
export const describeMailAttribution = (judgment: MailAttributionJudgment) =>
  [
    `${judgment.label}; ${judgment.basis}`,
    judgment.modelLabel || judgment.probability !== null
      ? `model ${judgment.modelLabel ?? "none"} at p=${judgment.probability ?? "?"}`
      : null,
    ...judgment.warnings,
  ]
    .filter(Boolean)
    .join("; ");

/**
 * Each Email's attribution. Own mail defaults to recipient; any other Email
 * short of a confident answer is uncertain.
 */
export async function judgeMailAttributions(
  mails: readonly JudgedMail[],
  owner: MailOwnerContext | null,
  usage: AiRunContext,
  port?: DecisionPort,
): Promise<MailAttributionJudgment[]> {
  const evidence = owner?.evidence ?? null;
  const warnings = owner?.warnings ?? [];
  const emails = mails.map((mail) => mailJudgmentEvidence(mail));
  const own = mails.map((mail, index) =>
    isOwnMail(mail, evidence, emails[index]!.htmlText),
  );
  const prompts = emails.map((email) =>
    MAIL_ATTRIBUTION_FEATURE.prompt(
      JSON.stringify({ mailboxOwner: evidence, email }),
    ),
  );
  const fits = prompts.map((prompt) => decisionChoiceFitsContext(prompt));
  const results = await runDecisionChoices(
    prompts.flatMap((prompt, index) =>
      fits[index]
        ? [{ ...prompt, feature: MAIL_ATTRIBUTION_FEATURE, usage, port }]
        : [],
    ),
  );
  let next = 0;
  return mails.map((_, index): MailAttributionJudgment => {
    const result = fits[index] ? results[next++] : undefined;
    const modelLabel =
      MAIL_ATTRIBUTION_FEATURE.choices[result?.selectedIndex ?? -1] ?? null;
    const confident = result?.confidence === "high" ? modelLabel : null;
    const decided = {
      modelLabel,
      probability: result?.probability ?? null,
      warnings,
    };
    // The default needs the model's actual answer; oversized evidence that
    // no model read stays uncertain even for own mail.
    if (own[index] && result)
      return {
        ...decided,
        label: confident === "third_party" ? "third_party" : "recipient",
        basis: "owner_default",
      };
    return {
      ...decided,
      label: confident ?? "uncertain",
      basis: fits[index] ? "model" : "oversized",
    };
  });
}

/** True only when the decision model confidently names the same purchase. */
export async function judgeSameMailPurchase(
  admitted: readonly JudgedMail[],
  candidate: JudgedMail,
  usage: AiRunContext,
  port?: DecisionPort,
): Promise<boolean> {
  const prompts = admitted
    .map((anchor) =>
      MAIL_SOURCE_RELATION_FEATURE.prompt(
        JSON.stringify({
          admitted: mailJudgmentEvidence(anchor),
          candidate: mailJudgmentEvidence(candidate),
        }),
      ),
    )
    .filter((prompt) => decisionChoiceFitsContext(prompt));
  if (!prompts.length) return false;
  const results = await runDecisionChoices(
    prompts.map((prompt) => ({
      ...prompt,
      feature: MAIL_SOURCE_RELATION_FEATURE,
      usage,
      port,
    })),
  );
  return results.some(
    (result) =>
      result.confidence === "high" &&
      MAIL_SOURCE_RELATION_FEATURE.choices[result.selectedIndex ?? -1] ===
        "same_purchase",
  );
}
