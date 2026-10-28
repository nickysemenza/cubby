import { z } from "zod";
import { plainDate } from "./base-entity";

import {
  ledgerPartyShortcode,
  runShortcode,
  purchaseShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifiers";
import { runStatus } from "./run-fields";

export const mailCoverageView = z.enum([
  "all",
  "activity",
  "never_searched",
  "incomplete",
  "attention",
]);
export type MailCoverageView = z.infer<typeof mailCoverageView>;

const count = z.number().int().nonnegative();

const mailCoverageState = z.enum([
  "no_search_identity",
  "not_started",
  "in_progress",
  "no_matches",
  "matches_found",
  "complete",
]);

const mailCoverageMailbox = z.strictObject({
  mailboxId: z.string(),
  memberId: ledgerPartyShortcode,
  memberName: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  resumeEnabled: z.boolean().nullable(),
  canControl: z.boolean(),
});

export const mailCoverageRow = z.strictObject({
  key: z.string(),
  vendorId: vendorShortcode,
  vendorName: z.string(),
  vendorAccountId: vendorAccountShortcode.nullable(),
  vendorAccountName: z.string().nullable(),
  mailboxId: z.string(),
  memberId: ledgerPartyShortcode,
  searchTerms: z.array(z.string()),
  state: mailCoverageState,
  searchesCompleted: count,
  searchesTotal: count,
  searches: z.array(
    z.strictObject({
      query: z.string(),
      state: z.enum(["not_started", "in_progress", "complete"]),
      completedAt: z.iso.datetime().nullable(),
      runId: runShortcode.nullable(),
      queuePosition: count.nullable(),
    }),
  ),
  queue: z.strictObject({
    state: z.enum(["running", "queued", "paused", "idle"]),
    position: count.nullable(),
    runId: runShortcode.nullable(),
    reason: z.string().nullable(),
  }),
  lastSearchedAt: z.iso.datetime().nullable(),
  controlledRun: z
    .strictObject({
      id: runShortcode,
      status: runStatus,
      queued: z.boolean(),
      phase: z.string().nullable(),
      from: plainDate.nullable(),
      to: plainDate.nullable(),
      imports: z.strictObject({
        running: count,
        paused: count,
        needsReview: count,
        failed: count,
        completed: count,
      }),
    })
    .nullable(),
  /** Known local sender/domain matches or attributed evidence, not a Gmail total. */
  scanned: count,
  classified: count,
  retained: count,
  linkedEmails: count,
  /** Linked Emails whose original content is still retained. */
  linkedRetainedEmails: count,
  /** Distinct linked Purchases; several Emails can link the same Purchase. */
  linkedPurchases: count,
  linkedPurchaseIds: z.array(purchaseShortcode),
});

export const mailCoverage = z.strictObject({
  mailboxes: z.array(mailCoverageMailbox),
  rows: z.array(mailCoverageRow),
});
export type MailCoverage = z.infer<typeof mailCoverage>;
export type MailCoverageRow = z.infer<typeof mailCoverageRow>;
