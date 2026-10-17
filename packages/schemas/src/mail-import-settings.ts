import { z } from "zod";

import { mailSearchProgress } from "./mailbox-research";

const mailboxId = z.string().min(1);

/** Stored switch: automatic Mail import runs only for listed mailboxes. */
export const mailImportSettings = z.strictObject({
  enabledMailboxes: z.array(mailboxId),
});
export type MailImportSettings = z.infer<typeof mailImportSettings>;

/** Frontier chat-model spend in the current fixed UTC window, classification excluded. */
export const aiBudgetStatus = z.strictObject({
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  limitUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
});
export type AiBudgetStatus = z.infer<typeof aiBudgetStatus>;

export const mailImportStatus = z.strictObject({
  mailboxes: z.array(
    z.strictObject({
      mailboxId,
      enabled: z.boolean(),
      searches: mailSearchProgress,
    }),
  ),
  budget: aiBudgetStatus,
});
export type MailImportStatus = z.infer<typeof mailImportStatus>;

export const setMailImportInput = z.strictObject({
  mailboxId,
  enabled: z.boolean(),
});
export type SetMailImportInput = z.infer<typeof setMailImportInput>;
