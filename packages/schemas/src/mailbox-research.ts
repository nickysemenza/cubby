import { workflowRecoveryProgress } from "./workflow-runs";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { z } from "zod";
import {
  emailShortcode,
  purchaseShortcode,
  financialTransactionShortcode,
  financialAccountShortcode,
  ledgerPartyShortcode,
} from "./identifier-fields";
import { executionAuthorizationRef } from "./execution-authorization.js";
import { importSourceIdentity } from "./import-source";

export const MAILBOX_RESEARCH_VERSION = "2026-10-11.1";
/** One Reclassify request records at most this many Emails in its Run. */
export const EMAIL_RECLASSIFY_LIMIT = 200;
export const mailboxClassification = z.enum([
  "related",
  "unrelated",
  "uncertain",
]);
export type MailboxClassification = z.infer<typeof mailboxClassification>;
/** Which step decided a classification: a deterministic rule, the decision model (Jev or Clef), the relevance model, or an Email resolution. */
export const mailboxClassificationStage = z.enum([
  "rule",
  "decision",
  "model",
  "resolution",
]);
export type MailboxClassificationStage = z.infer<
  typeof mailboxClassificationStage
>;
export const MAILBOX_CLASSIFICATION_LABEL = {
  related: "Related",
  unrelated: "Unrelated",
  uncertain: "Uncertain",
} as const satisfies Record<MailboxClassification, string>;
export const MAILBOX_CLASSIFICATION_STAGE_LABEL = {
  rule: "Rule",
  decision: "Decision model",
  model: "Relevance model",
  resolution: "Member resolution",
} as const satisfies Record<MailboxClassificationStage, string>;
/** The Email list cell: Relevance and the stage that decided it. */
export const relevanceLabel = (
  classification: MailboxClassification | null,
  stage: MailboxClassificationStage | null,
) =>
  classification === null
    ? null
    : [
        MAILBOX_CLASSIFICATION_LABEL[classification],
        stage && MAILBOX_CLASSIFICATION_STAGE_LABEL[stage],
      ]
        .filter(Boolean)
        .join(" · ");
/** A classification and why it was reached. */
export type MailboxClassificationDecision = {
  classification: MailboxClassification;
  stage: MailboxClassificationStage;
  reason: string;
};
export const mailboxDiscoveryStartOutput = z.object({
  started: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
});
export type MailboxDiscoveryStartOutput = z.infer<
  typeof mailboxDiscoveryStartOutput
>;
export const emailStatus = z.enum([
  "pending",
  "researching",
  "completed",
  "blocked",
  "deleted",
  "excluded",
]);
export type EmailStatus = z.infer<typeof emailStatus>;
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
  /** Present only for Runs whose every handled Email has a durable handling receipt. */
  emailAuditVersion: z.literal(1).optional(),
  executionAuthorization: executionAuthorizationRef.optional(),
  executionPolicy: z
    .enum(["classification_only", "import"])
    .default("classification_only"),
  mailboxId: z.string().min(1),
  scopedQueries: z.array(mailboxScopedQuery),
});
export const mailboxDiscoveryProgress = z.object({
  ...workflowRecoveryProgress.shape,
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
  imageReadability: z
    .enum(["sufficient", "needs_detail", "unreadable"])
    .optional(),
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

/**
 * Evidence omissions in Mail triage's bounded view, supplied to the decision
 * model and exposed in previews without overriding its definite choice.
 */
export const mailTriageIncompleteReason = z.enum([
  /** An amount, order/invoice number or receipt phrase fell outside the view,
   * or the body was clipped while cues past the scan bound went unchecked. */
  "purchase_cue_clipped",
  "attachments",
  /** Images carry the content and no readable text accompanies them. */
  "image_only",
  /** A cue-bearing link or image, or a structured-data block, was clipped. */
  "links_clipped",
  "images_clipped",
  "structured_data_clipped",
  /** The HTML compactor hit its own text bound. */
  "compactor_truncated",
  /** The normalizer keeps one text and one HTML body; this message had more. */
  "mime_parts_dropped",
  "headers_clipped",
]);
export type MailTriageIncompleteReason = z.infer<
  typeof mailTriageIncompleteReason
>;

export const mailTriagePreviewInput = mailMessageRef.extend({
  /** Pins the decision model; omitted samples the live traffic split. */
  decisionModel: supportedDecisionModelSchema.optional(),
});
export type MailTriagePreviewInput = z.infer<typeof mailTriagePreviewInput>;

export const mailTriagePreviewOut = z.object({
  classification: mailboxClassification,
  stage: mailboxClassificationStage,
  reason: z.string(),
  /** The decision model asked, or null when a rule decided before the decision model. */
  model: supportedDecisionModelSchema.nullable(),
  /** Null when the original had no readable body and no view was built. */
  view: z
    .object({
      bytes: z.number().int().nonnegative(),
      complete: z.boolean(),
      incompleteReasons: z.array(mailTriageIncompleteReason),
    })
    .nullable(),
});
export type MailTriagePreviewOut = z.infer<typeof mailTriagePreviewOut>;

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

export const mailFinancialReview = z.strictObject({
  transactionId: financialTransactionShortcode,
  reviewedAccountId: financialAccountShortcode,
  sourceAccountLabel: z.string().trim().min(1).max(320),
  reviewReason: z.string().trim().min(1).max(1_000),
});
export const mailSettlementReview = z.strictObject({
  refundAmount: z
    .number()
    .finite()
    .negative()
    .refine(
      (amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 0.0000001,
      "Refund amount must be whole cents.",
    ),
  associations: z
    .array(mailFinancialReview)
    .min(1)
    .max(50)
    .refine(
      (rows) =>
        new Set(rows.map((row) => row.transactionId)).size === rows.length,
      "Refund references must be distinct.",
    ),
});
export type MailSettlementReview = z.infer<typeof mailSettlementReview>;
export const mailFinancialAssociation = mailFinancialReview.extend({
  currentAccountId: financialAccountShortcode.nullable(),
  evidenceChecksum: sha256,
  reviewedAt: z.iso.datetime(),
  transactionDeleted: z.boolean(),
  reviewedAccountDeleted: z.boolean(),
  accountChanged: z.boolean(),
});
export const mailResolveDisposition = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("linked"),
      purchaseIds: z
        .array(purchaseShortcode)
        .min(1)
        .max(50)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "Purchase links must be distinct.",
        ),
      event: mailEvent,
      settlement: mailSettlementReview.optional(),
    })
    .describe(
      "The Email records this lifecycle event of existing Purchases. Writes no Expenses.",
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
export const mailResolveInput = mailMessageRef.extend({
  checksum: sha256.describe(
    "The checksum imports_read.mail returned for this Email.",
  ),
  disposition: mailResolveDisposition,
});
export type MailResolveInput = z.infer<typeof mailResolveInput>;

export const mailResolveOut = mailMessageRef.extend({
  status: emailStatus,
  disposition: z.enum(["linked", "unresolved", "unrelated"]),
  purchaseIds: z.array(purchaseShortcode),
  financialAssociations: z.array(mailFinancialAssociation),
});
export const MAIL_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
/** A retained attachment's original bytes, read through `mail.read`. */
export const mailAttachmentOriginal = z.strictObject({
  attachmentId: z.string().min(1).max(200),
  filename: z.string().max(1_000),
  mimeType: z.string().regex(/^(?:application\/pdf|image\/[A-Za-z0-9.+-]+)$/u),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  dataBase64: z.string().max(Math.ceil(MAIL_ATTACHMENT_MAX_BYTES / 3) * 4),
});
export type MailAttachmentOriginal = z.infer<typeof mailAttachmentOriginal>;

/**
 * `accepted`: an import accepted the Email as the Purchase's source.
 * `linked`: a reviewed link on one of its order events. Both are links;
 * Relevance and import outcome are separate facts (`entity_read` on email).
 */
export const mailPurchaseAssociation = z.object({
  purchaseId: purchaseShortcode,
  purchaseDeleted: z.boolean(),
  kind: z.enum(["accepted", "linked"]),
});

export const mailReadOut = mailMessageRef.extend({
  /** The Email's EML- code: what mail.import and mail.decide_purchase take. */
  id: emailShortcode,
  threadId: z.string().nullable(),
  checksum: sha256,
  sender: z.string().nullable(),
  subject: z.string().nullable(),
  receivedAt: z.iso.datetime().nullable(),
  content: retainedMailContent,
  attachments: z.array(
    z.object({
      attachmentId: z.string(),
      filename: z.string(),
      mimeType: z.string(),
      checksum: z.string().nullable(),
    }),
  ),
  originalAttachment: mailAttachmentOriginal.optional(),
  /** True when Pi reads an Email its Mail import Run admitted. */
  boundToRun: z.boolean(),
  purchaseIds: z.array(purchaseShortcode).default([]),
  purchaseAssociations: z.array(mailPurchaseAssociation).default([]),
  acceptedSourceOrders: z
    .array(
      z.object({
        sourceOrderId: z.uuid(),
        purchaseId: purchaseShortcode,
        purchaseDeleted: z.boolean(),
        source: importSourceIdentity,
      }),
    )
    .default([]),
  financialAssociations: z.array(mailFinancialAssociation).default([]),
});
export const mailSearchOut = z.object({
  status: z.enum(["ok", "mailbox_required", "gmail_reconnect_required"]),
  mailboxes: z.array(z.string()),
  messages: z.array(
    mailMessageRef.extend({
      /** With `checksum`, the exact selection mail.import takes. */
      id: emailShortcode,
      checksum: sha256,
      threadId: z.string().nullable(),
      classification: mailboxClassification.nullable(),
      status: emailStatus,
      sender: z.string().nullable(),
      subject: z.string().nullable(),
      receivedAt: z.iso.datetime().nullable(),
    }),
  ),
  nextPageToken: z.string().nullable(),
});

/** Stored execution evidence is separate from the Email's later state. */
export const discoveryEmailReceipt = z.object({
  id: emailShortcode,
  emailId: z.uuid(),
  sourceChecksum: z.string().nullable(),
  handledAt: z.iso.datetime(),
  observationId: z.uuid().nullable(),
  outcome: z.enum([
    "classified",
    "reused",
    "frozen",
    "removed",
    "excluded",
    "changed",
  ]),
  classification: mailboxClassification.nullable(),
  stage: mailboxClassificationStage.nullable(),
  ownershipAtExecution: z.object({
    memberId: ledgerPartyShortcode.nullable(),
    mailboxId: z.string(),
  }),
});
export const discoveryEmailAuditPage = z.object({
  coverage: z.enum(["complete", "incomplete"]),
  total: z.number().int().nonnegative(),
  nextCursor: z.number().int().nonnegative().nullable(),
  items: z.array(
    discoveryEmailReceipt.omit({ emailId: true, observationId: true }).extend({
      evidence: z.enum(["observation", "receipt"]),
      currentAvailability: z.enum([
        "available",
        "removed",
        "ownership_changed",
      ]),
      current: z
        .object({
          classification: mailboxClassification,
          stage: mailboxClassificationStage.nullable(),
          status: emailStatus,
          checksum: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
});
