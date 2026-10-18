/**
 * Declared semantic judgments about one retained original: whose transaction
 * it evidences and whether a supporting original is the same purchase. Both
 * are closed Decision features over checksum-bound evidence; only a confident
 * answer counts, and neither creates records. A vendor's direct mail to the
 * mailbox owner is attributed by the host rule in `mail-owner.ts` instead.
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

import { type MailOwnerEvidence, ownMailAttribution } from "./mail-owner";

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
 * One attribution decision. `owner_rule`: the host decided `recipient` from
 * the owner's addresses without a model; `model`: the decision model's label
 * and selected probability (below high confidence reads as uncertain);
 * `oversized`: the evidence exceeded the decision context.
 */
export type MailAttributionJudgment = {
  label: MailAttribution;
  basis: "owner_rule" | "model" | "oversized";
  modelLabel: MailAttribution | null;
  probability: number | null;
};

/** Raw decision diagnostics for refusal messages. */
export const describeMailAttribution = (judgment: MailAttributionJudgment) =>
  judgment.basis === "model"
    ? `${judgment.label}; model ${judgment.modelLabel ?? "none"} at p=${judgment.probability ?? "?"}`
    : `${judgment.label}; ${judgment.basis}`;

/** Each Email's attribution; anything short of a confident answer is uncertain. */
export async function judgeMailAttributions(
  mails: readonly JudgedMail[],
  owner: MailOwnerEvidence | null,
  usage: AiRunContext,
  port?: DecisionPort,
): Promise<MailAttributionJudgment[]> {
  const ruled = mails.map((mail) => ownMailAttribution(mail, owner));
  const prompts = mails.map((mail, index) =>
    ruled[index]
      ? null
      : MAIL_ATTRIBUTION_FEATURE.prompt(
          JSON.stringify({
            mailboxOwner: owner,
            email: mailJudgmentEvidence(mail),
          }),
        ),
  );
  const fits = prompts.map(
    (prompt) => prompt !== null && decisionChoiceFitsContext(prompt),
  );
  const results = await runDecisionChoices(
    prompts.flatMap((prompt, index) =>
      prompt && fits[index]
        ? [{ ...prompt, feature: MAIL_ATTRIBUTION_FEATURE, usage, port }]
        : [],
    ),
  );
  let next = 0;
  return ruled.map((rule, index): MailAttributionJudgment => {
    if (rule)
      return {
        label: rule,
        basis: "owner_rule",
        modelLabel: null,
        probability: null,
      };
    if (!fits[index])
      return {
        label: "uncertain",
        basis: "oversized",
        modelLabel: null,
        probability: null,
      };
    const result = results[next++];
    const choice =
      MAIL_ATTRIBUTION_FEATURE.choices[result?.selectedIndex ?? -1] ?? null;
    return {
      label: result?.confidence === "high" && choice ? choice : "uncertain",
      basis: "model",
      modelLabel: choice,
      probability: result?.probability ?? null,
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
