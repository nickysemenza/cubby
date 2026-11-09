import { z } from "zod";

import { mailSearchProgress } from "./mailbox-research";

const mailboxId = z.string().min(1);

/** Stored switch: automatic Mail import runs only for listed mailboxes. */
export const mailImportSettings = z.strictObject({
  enabledMailboxes: z.array(mailboxId),
  /** A member-selected import parks queued automatic work until explicit resume. */
  controlledPauses: z
    .array(z.strictObject({ mailboxId, enabledBefore: z.boolean() }))
    .default([]),
});
export type MailImportSettings = z.infer<typeof mailImportSettings>;

/** The Claude subscriber-credit budget a member may set per six-hour window. */
export const creditBudgetLimitUsd = z.number().nonnegative().max(100);

/** Stored household AI budget settings; an absent row keeps the defaults. */
export const aiBudgetSettings = z.strictObject({
  creditLimitUsd: creditBudgetLimitUsd,
  openaiCreditLimitUsd: creditBudgetLimitUsd.default(1.5),
  planLimitUsd: creditBudgetLimitUsd.default(2),
  paidLimitUsd: creditBudgetLimitUsd.default(1),
});
export type AiBudgetSettings = z.infer<typeof aiBudgetSettings>;

const budgetUse = z.strictObject({
  limitUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
});

/**
 * Frontier chat-model spend in the current fixed UTC window. `credit`,
 * `openaiCredit` and `plan` sum standard API cost separately for the two
 * provider credit pools and ChatGPT plan; `paid` sums charged cost.
 */
export const aiBudgetStatus = z.strictObject({
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  credit: budgetUse,
  openaiCredit: budgetUse,
  plan: budgetUse,
  paid: budgetUse,
});
export type AiBudgetStatus = z.infer<typeof aiBudgetStatus>;

/**
 * Whether the household ChatGPT plan can carry background work now:
 * `paused` after a recorded quota refusal until its reset (`until`);
 * `reason` keeps the raw refusal or connection diagnostic.
 */
export const chatGptPlanAvailability = z.strictObject({
  state: z.enum([
    "available",
    "paused",
    "disconnected",
    "needs_reauthorization",
  ]),
  until: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
});
export type ChatGptPlanAvailability = z.infer<typeof chatGptPlanAvailability>;

/**
 * Whether a provider accepts this funding source: `refused` after a recorded
 * funding refusal (a Console spend limit, a spent credit balance, an empty AI
 * Gateway balance) until the date it names or the window end (`until`), probed
 * once per window; `reason` keeps the provider's raw refusal.
 */
export const fundingRefusalState = z.strictObject({
  state: z.enum(["available", "refused"]),
  until: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
});

/** The funding sources whose recorded refusal a member can clear. */
export const fundingRefusalSource = z.enum(["credit", "openaiCredit", "paid"]);
export type FundingRefusalSource = z.infer<typeof fundingRefusalSource>;

/**
 * Whether background work can draw this source now, derived on the server
 * from its window budget and recorded refusal or connection state. `blocker`
 * names why not; `until` is when it recovers by itself, if known.
 */
export const fundingAvailability = z.strictObject({
  usable: z.boolean(),
  blocker: z
    .enum([
      "budget_spent",
      "provider_refused",
      "plan_limit",
      "disconnected",
      "needs_reauthorization",
      "gateway_balance_empty",
    ])
    .nullable(),
  until: z.iso.datetime().nullable(),
});
export type FundingAvailability = z.infer<typeof fundingAvailability>;

const withAvailability = { availability: fundingAvailability };

/**
 * Household-wide frontier AI funding (ADR 0017): separate provider credit
 * budgets and refusals, the plan, and the paid budget and gateway refusal
 * decide when background work waits.
 */
export const aiFundingStatus = aiBudgetStatus.extend({
  credit: budgetUse.extend(fundingRefusalState.shape).extend(withAvailability),
  openaiCredit: budgetUse
    .extend(fundingRefusalState.shape)
    .extend(withAvailability),
  plan: budgetUse
    .extend(chatGptPlanAvailability.shape)
    .extend(withAvailability),
  paid: budgetUse.extend(fundingRefusalState.shape).extend(withAvailability),
});
export type AiFundingStatus = z.infer<typeof aiFundingStatus>;

export const mailImportStatus = z.strictObject({
  mailboxes: z.array(
    z.strictObject({
      mailboxId,
      label: z.string(),
      enabled: z.boolean(),
      searches: mailSearchProgress,
    }),
  ),
});
export type MailImportStatus = z.infer<typeof mailImportStatus>;

export const setMailImportInput = z.strictObject({
  mailboxId,
  enabled: z.boolean(),
});
export type SetMailImportInput = z.infer<typeof setMailImportInput>;

/**
 * A member's one-Run paid grant: it resumes a paused Run now and lets it spend
 * past the paid budget by the confirmed `paidOverBudgetUsd` for the window
 * the grant was made in.
 */
export const paidOverBudgetUsd = z.number().positive().max(10);
