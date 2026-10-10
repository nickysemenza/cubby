import { z } from "zod";
import { purchaseShortcode } from "./identifier-fields";
import { executionAuthorizationRef } from "./execution-authorization.js";
import { acceptedResearchFact } from "./research-facts";
import { researchAssessment } from "./research-assessment";

export const MAILBOX_RESEARCH_VERSION = "2026-10-07.1";
export const mailboxClassification = z.enum([
  "related",
  "unrelated",
  "uncertain",
]);
export type MailboxClassification = z.infer<typeof mailboxClassification>;
export const mailboxDiscoveryStartOutput = z.object({
  started: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});
export type MailboxDiscoveryStartOutput = z.infer<
  typeof mailboxDiscoveryStartOutput
>;
export const mailboxMessageStatus = z.enum([
  "pending",
  "researching",
  "completed",
  "blocked",
  "deleted",
  "excluded",
]);
export type MailboxMessageStatus = z.infer<typeof mailboxMessageStatus>;
export const mailboxScopedQuery = z.object({
  key: z.string().min(1),
  query: z.string().min(1),
});
export type MailboxScopedQuery = z.infer<typeof mailboxScopedQuery>;
const pagePosition = z.object({
  pageToken: z.string().nullable(),
  completed: z.boolean(),
});
/** Tokens move only after that page's acquisition and research dispatch succeed. */
export const mailboxCoverage = z.object({
  version: z.literal(1),
  baselineHistoryId: z.string().min(1),
  broad: pagePosition,
  scoped: z.array(mailboxScopedQuery.extend(pagePosition.shape)),
  history: z.object({
    historyId: z.string().min(1),
    pageToken: z.string().nullable(),
    targetHistoryId: z.string().nullable(),
  }),
  nextLane: z.enum(["scan", "history"]),
});
export type MailboxCoverage = z.infer<typeof mailboxCoverage>;
export const mailboxHistoryEvent = z.object({
  sourceKey: z.string(),
  mailboxId: z.string(),
  historyId: z.string(),
  messageId: z.string(),
  threadId: z.string().nullable(),
  kind: z.enum([
    "message_added",
    "message_deleted",
    "labels_added",
    "labels_removed",
  ]),
  labelIds: z.array(z.string()),
});
export const mailboxPage = z.object({
  messageIds: z.array(z.string()),
  events: z.array(mailboxHistoryEvent),
  startCoverage: mailboxCoverage,
  nextCoverage: mailboxCoverage,
});
export type MailboxPage = z.infer<typeof mailboxPage>;
export const mailboxDiscoveryInput = z.object({
  executionAuthorization: executionAuthorizationRef.optional(),
  mailboxId: z.string().min(1),
  scopedQueries: z.array(mailboxScopedQuery),
});
export const mailboxDiscoveryProgress = z.object({
  attempt: z.number().int().nonnegative(),
  phase: z.enum(["listing", "fetching", "completed", "failed", "paused"]),
  pagesDone: z.number().int().nonnegative().default(0),
  page: mailboxPage.optional(),
  saved: z.number().int().nonnegative().default(0),
  deleted: z.number().int().nonnegative().default(0),
  excluded: z.number().int().nonnegative().default(0),
  unrelated: z.number().int().nonnegative().default(0),
  events: z.number().int().nonnegative().default(0),
  droppedEvents: z.number().int().nonnegative().default(0),
});
export type MailboxDiscoveryProgress = z.infer<typeof mailboxDiscoveryProgress>;
/** Stateless relevance is resolved before original content enters a durable transcript. */
export const mailboxRelevanceDecision = z.object({
  classification: mailboxClassification,
  reason: z.string().optional(),
});
export type MailboxRelevanceDecision = z.infer<typeof mailboxRelevanceDecision>;

/** Full normalized original context retained only after purchase relevance is resolved. */
export const retainedMailContent = z.object({
  snippet: z.string().nullable(),
  bodyText: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type RetainedMailContent = z.infer<typeof retainedMailContent>;

/** Import resolution is shared by retained mail, browser originals, and validation. */
export const researchImportResult = z.object({
  status: z.enum([
    "verified",
    "partially_verified",
    "researched_with_gaps",
    "ambiguous",
    "temporarily_blocked",
    "no_source_found",
    "unrelated",
  ]),
  purchaseIds: z.array(z.uuid()),
  productIds: z.array(z.uuid()),
  eventIds: z.array(z.uuid()),
  retirement: z.object({ receiptId: z.uuid() }).nullable().default(null),
  proposedOrders: z.array(z.json()).default([]),
  proposedLinks: z.array(z.json()).default([]),
  proposedFacts: z.array(acceptedResearchFact).default([]),
  refusals: researchAssessment.shape.rejected.default([]),
});
export type ResearchImportResult = z.infer<typeof researchImportResult>;

/** Lifecycle event an Email records about a Purchase. */
export const mailEvent = z.enum([
  "confirmation",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
  "other",
]);
export type MailEvent = z.infer<typeof mailEvent>;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * A retained Email, named by its provider identity so a caller can correlate
 * it with its own mail connector (Gmail `messageId`; `threadId` is context).
 */
export const mailMessageRef = z.object({
  mailboxId: z.string().trim().min(1).max(320),
  messageId: z.string().trim().min(1).max(200),
});
export type MailMessageRef = z.infer<typeof mailMessageRef>;

export const mailReadInput = mailMessageRef.extend({
  attachmentId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("A provider attachment id from the message's attachment list."),
});
export type MailReadInput = z.infer<typeof mailReadInput>;

export const mailSearchInput = z.object({
  mailboxId: z.string().trim().min(1).max(320).optional(),
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "Gmail search syntax, e.g. an order number or `from:shop.example`. Spam and Trash are always excluded.",
    ),
  pageToken: z.string().min(1).max(2_000).optional(),
});
export type MailSearchInput = z.infer<typeof mailSearchInput>;

export const mailResolveDisposition = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("linked"),
      purchaseId: purchaseShortcode,
      event: mailEvent,
    })
    .describe(
      "The Email records this lifecycle event of an existing Purchase (shipment, delivery, cancellation, refund …). Writes no Expenses.",
    ),
  z
    .object({
      kind: z.literal("unresolved"),
      reason: z.string().trim().min(1).max(1_000),
    })
    .describe(
      "An order Email whose Purchase cannot be established yet; the reason names the gap.",
    ),
  z
    .object({
      kind: z.literal("unrelated"),
      reason: z.string().trim().min(1).max(1_000),
    })
    .describe(
      "Not about a purchase. Cubby deletes its retained copy unless a reviewed decision or import already uses it.",
    ),
]);
export type MailResolveDisposition = z.infer<typeof mailResolveDisposition>;

export const mailResolveInput = mailMessageRef.extend({
  checksum: sha256.describe("The checksum mail.read returned for this Email."),
  disposition: mailResolveDisposition,
});
export type MailResolveInput = z.infer<typeof mailResolveInput>;

export const mailResolveOut = mailMessageRef.extend({
  status: mailboxMessageStatus,
  disposition: z.enum(["linked", "unresolved", "unrelated"]),
  purchaseId: purchaseShortcode.nullable(),
});
export type MailResolveOut = z.infer<typeof mailResolveOut>;
