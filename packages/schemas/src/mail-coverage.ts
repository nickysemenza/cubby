import { z } from "zod";
import { plainDate } from "./base-entity";

import {
  ledgerPartyShortcode,
  runShortcode,
  purchaseShortcode,
  vendorAccountShortcode,
  vendorShortcode,
  emailShortcode,
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

export const senderAttribution = z.strictObject({
  sender: z.string(),
  state: z.enum(["unmapped", "verified", "shared", "disputed", "excluded"]),
  origin: z.enum(["learned", "member"]).nullable(),
  vendorId: vendorShortcode.nullable(),
  vendors: z.array(z.object({ id: vendorShortcode, name: z.string() })),
  evidenceCount: count,
  evidence: z.array(
    z.object({
      emailId: emailShortcode,
      purchaseId: purchaseShortcode,
      vendorId: vendorShortcode,
      vendorName: z.string(),
    }),
  ),
});
export type SenderAttribution = z.infer<typeof senderAttribution>;

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
  domains: z.array(z.string()),
  senderAddresses: z.array(z.string()),
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
  senderAttributions: z.array(senderAttribution),
  mailboxes: z.array(mailCoverageMailbox),
  rows: z.array(mailCoverageRow),
  discovery: z.array(
    z.strictObject({
      mailboxId: z.string(),
      lastPolledAt: z.iso.datetime().nullable(),
      newMailCatchupPending: z.boolean().nullable(),
      runId: runShortcode.nullable(),
      runStatus: runStatus.nullable(),
      searchesCompleted: count,
      searchesTotal: count,
      scanned: count,
      classified: count,
      retained: count,
      pending: count,
      blocked: count,
      imported: count,
      sellerUnresolved: count,
    }),
  ),
  sharedSenders: z.array(
    z.strictObject({
      mailboxId: z.string(),
      sender: z.string(),
      attribution: senderAttribution,
      query: z.string(),
      state: z.enum(["not_started", "in_progress", "complete"]),
      completedAt: z.iso.datetime().nullable(),
      runId: runShortcode.nullable(),
      scanned: count,
      classified: count,
      retained: count,
      related: count,
      imported: count,
      linkedEmails: count,
      linkedPurchases: count,
      sellerUnresolved: count,
    }),
  ),
  /** Latest 50 per connected mailbox; discovery.sellerUnresolved is the full local count. */
  unresolvedEmails: z.array(
    z.strictObject({
      id: emailShortcode,
      mailboxId: z.string(),
      sender: z.string().nullable(),
      subject: z.string().nullable(),
      receivedAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type MailCoverage = z.infer<typeof mailCoverage>;
export type MailCoverageRow = z.infer<typeof mailCoverageRow>;
