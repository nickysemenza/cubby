import { z } from "zod";
import { plainDate } from "./base-entity";

import {
  ledgerPartyShortcode,
  runShortcode,
  vendorAccountShortcode,
  vendorShortcode,
} from "./identifiers";
import { runStatus } from "./run-fields";

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
  mailboxId: z.string(),
  memberId: ledgerPartyShortcode,
  searchTerms: z.array(z.string()),
  state: mailCoverageState,
  searchesCompleted: count,
  searchesTotal: count,
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
  /** Distinct linked Purchases; several Emails can link the same Purchase. */
  linkedPurchases: count,
});

export const mailCoverage = z.strictObject({
  mailboxes: z.array(mailCoverageMailbox),
  rows: z.array(mailCoverageRow),
});
export type MailCoverage = z.infer<typeof mailCoverage>;
export type MailCoverageRow = z.infer<typeof mailCoverageRow>;
