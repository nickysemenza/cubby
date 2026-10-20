import { z } from "zod";

import { mailSearchProgress } from "./mailbox-research";

const mailboxId = z.string().min(1);

/** Stored switch: automatic Mail import runs only for listed mailboxes. */
export const mailImportSettings = z.strictObject({
  enabledMailboxes: z.array(mailboxId),
});
export type MailImportSettings = z.infer<typeof mailImportSettings>;

/** The Claude subscriber-credit budget a member may set per six-hour window. */
export const creditBudgetLimitUsd = z.number().nonnegative().max(100);

/** Stored household AI budget settings; an absent row keeps the defaults. */
export const aiBudgetSettings = z.strictObject({
  creditLimitUsd: creditBudgetLimitUsd,
});
export type AiBudgetSettings = z.infer<typeof aiBudgetSettings>;

const budgetUse = z.strictObject({
  limitUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
});

/**
 * Frontier chat-model spend in the current fixed UTC window. `credit` and
 * `plan` sum the standard API cost of Claude subscriber-credit and ChatGPT
 * plan calls, which charge $0; `paid` sums the charged cost of everything.
 */
export const aiBudgetStatus = z.strictObject({
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  credit: budgetUse,
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
 * Whether Anthropic accepts the Claude subscriber credit: `refused` after a
 * recorded provider refusal (a Console spend limit, a spent balance) until the
 * date it names or the window end (`until`), probed once per window; `reason`
 * keeps the provider's raw refusal.
 */
export const claudeCreditAvailability = z.strictObject({
  state: z.enum(["available", "refused"]),
  until: z.iso.datetime().nullable(),
  reason: z.string().nullable(),
});

/**
 * Household-wide frontier AI funding (ADR 0017): both budgets, the credit's
 * refusal state and the plan, which together decide whether background work
 * waits.
 */
export const aiFundingStatus = aiBudgetStatus.extend({
  credit: budgetUse.extend(claudeCreditAvailability.shape),
  plan: budgetUse.extend(chatGptPlanAvailability.shape),
});
export type AiFundingStatus = z.infer<typeof aiFundingStatus>;

export const mailImportStatus = z.strictObject({
  mailboxes: z.array(
    z.strictObject({
      mailboxId,
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

// A budget update replaces the complete stored settings, including its strict unknown-key policy.
export const setCreditBudgetInput = aiBudgetSettings;

/**
 * A member's one-Run paid grant: it resumes a paused Run now and lets it spend
 * past the paid budget by the confirmed `paidOverBudgetUsd` for the window
 * the grant was made in.
 */
export const paidOverBudgetUsd = z.number().positive().max(10);
