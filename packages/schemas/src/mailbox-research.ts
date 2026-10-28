import { shipmentEvidence } from "./shipment-evidence";
import { supportedDecisionModelSchema } from "@cubby/shared/ai/models";
import { z } from "zod";
import {
  entityIdSchema,
  emailShortcode,
  purchaseShortcode,
  financialTransactionShortcode,
  financialAccountShortcode,
  ledgerPartyShortcode,
  runShortcode,
} from "./identifier-fields";
import { importSourceIdentity } from "./import-source";
import type { MailSearchState } from "./mail-search-fields";
import { controlledMailDateRange } from "./mail-coverage-control";

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
const scopedQueryPosition = mailboxScopedQuery.extend({
  ...pagePosition.shape,
  /** When the last page finished; absent on entries completed before it was recorded. */
  completedAt: z.iso.datetime().optional(),
  /** Emails retained from this search's pages; absent before it was recorded. */
  emailCount: z.number().int().nonnegative().optional(),
  /** All Gmail matches in committed pages; absent when older pages never counted them. */
  messageCount: z.number().int().nonnegative().optional(),
});
export type MailboxScopedPosition = z.infer<typeof scopedQueryPosition>;
/** Tokens move only after that page's acquisition and research dispatch succeed. */
export const mailboxCoverage = z.object({
  version: z.literal(1),
  baselineHistoryId: z.string().min(1),
  broad: pagePosition,
  scoped: z.array(scopedQueryPosition),
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
  /** The targeted search this page advanced; absent for a new-mail page. */
  scopedKey: z.string().min(1).optional(),
  /**
   * Retained sources across this page's attempts, saved before research
   * dispatch: a retry skips an Email whose import already completed, so its
   * own ingestion result would undercount the page.
   */
  retainedOrderMailIds: z.array(z.string().min(1)).optional(),
});
export type MailboxPage = z.infer<typeof mailboxPage>;
export const mailboxDiscoveryInput = z.object({
  /** Present only for Runs whose every handled Email has a durable handling receipt. */
  emailAuditVersion: z.literal(1).optional(),
  executionPolicy: z
    .enum(["classification_only", "import"])
    .default("classification_only"),
  mailboxId: z.string().min(1),
  scopedQueries: z.array(mailboxScopedQuery),
  /** A member-selected Vendor uses only its searches and never the history lane. */
  controlled: controlledMailDateRange.optional(),
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
  imageReadability: z
    .enum(["sufficient", "needs_detail", "unreadable"])
    .optional(),
  reason: z.string().optional(),
});
export type MailboxRelevanceDecision = z.infer<typeof mailboxRelevanceDecision>;

/** Model-copied literals for one Email's financial event; the host verifies each against the original. */
export const mailFinancialEventModelOutput = z.strictObject({
  kind: z.enum([
    "none",
    "purchase_payment",
    "refund",
    "incoming_payment",
    "transfer",
    "card_repayment",
    "reimbursement",
  ]),
  confidence: z.enum(["high", "medium", "low"]),
  amountText: z.string().max(80).nullable(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .nullable(),
  sourceAccountLabel: z.string().max(200).nullable(),
  providerEventId: z.string().max(200).nullable(),
  occurredOn: z.string().max(80).nullable(),
  counterpartyLabel: z.string().max(200).nullable(),
});
export type MailFinancialEventModelOutput = z.infer<
  typeof mailFinancialEventModelOutput
>;

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
 * Retained Emails linking a supporting original to one a Mail import Run
 * admitted, judged pairwise along the path.
 */
export const mailAdmissionPath = z
  .array(mailMessageRef)
  .min(1)
  .max(3)
  .describe(
    "For an Email this Run has not admitted: the retained Emails in its mailbox that connect it to one the Run admitted, nearest the admitted Email first. Each must share an order, tracking or invoice identifier with the next (a shipping Email tying an admitted carrier notice's tracking number to this order number). Every Email on the path joins the Run as a supporting original.",
  );

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

export const mailImageEvidence = z.object({
  attempted: z.number().int().nonnegative(),
  prepared: z.number().int().nonnegative(),
  supplied: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  sourceBytes: z.number().int().nonnegative(),
  requestBytes: z.number().int().nonnegative(),
  complete: z.boolean(),
  failures: z.array(z.string()),
  detailRetried: z.boolean(),
  imageReadability: mailboxRelevanceDecision.shape.imageReadability
    .unwrap()
    .nullable(),
  rawClassification: mailboxClassification.nullable(),
});
export type MailImageEvidence = z.infer<typeof mailImageEvidence>;

export const mailTriagePreviewOut = z.object({
  classification: mailboxClassification,
  stage: mailboxClassificationStage,
  reason: z.string(),
  /** The final deciding model, or null when no model ran. */
  model: z.string().nullable(),
  runId: runShortcode,
  triage: z.object({
    classification: mailboxClassification,
    stage: mailboxClassificationStage,
    reason: z.string(),
    model: supportedDecisionModelSchema.nullable(),
  }),
  relevance: mailboxRelevanceDecision.nullable(),
  imageEvidence: mailImageEvidence.nullable(),
  usage: z.object({
    calls: z.number().int().nonnegative(),
    accountingPending: z.boolean(),
    elapsedMs: z.number().nonnegative(),
    standardCost: z.number().nullable(),
    chargedCost: z.number().nullable(),
  }),
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

/**
 * The purchase agent's output cap for an Email read. A read's serialized
 * response (text or HTML page, plus metadata) stays below it, so the agent
 * never cuts a read before its last line or total.
 */
export const MAIL_READ_RESPONSE_MAX_BYTES = 200_000;

/** Raw HTML page bound for `includeHtml` reads, measured JSON-escaped. */
export const MAIL_READ_HTML_PAGE_MAX_BYTES = 100_000;

export const mailReadInput = mailMessageRef.extend({
  attachmentId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("A provider attachment id from the message's attachment list."),
  includeHtml: z
    .boolean()
    .optional()
    .describe(
      "Return one page of the raw HTML body instead of the compact text. Omitted: only compact text.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "UTF-8 byte offset of the page to read: 0, or the previous page's nextOffset. Pages the compact body text, or the raw HTML with includeHtml.",
    ),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(MAIL_READ_HTML_PAGE_MAX_BYTES)
    .optional()
    .describe(
      `JSON-escaped UTF-8 bytes of raw HTML per page (includeHtml), default ${MAIL_READ_HTML_PAGE_MAX_BYTES}. A page always holds at least one whole character.`,
    ),
});
export type MailReadInput = z.infer<typeof mailReadInput>;

/** Compact text body bound, measured JSON-escaped; below MAIL_READ_RESPONSE_MAX_BYTES. */
export const MAIL_READ_TEXT_MAX_BYTES = 120_000;

/** Serialized bound for a compact read's images, and for its structured data. */
export const MAIL_READ_IMAGES_MAX_BYTES = 4_000;
export const MAIL_READ_STRUCTURED_MAX_BYTES = 4_000;

/**
 * Serialized link bound for a compact read. Click-tracking redirects run over
 * 1 KB each, so links past the bound are counted in `linksOmitted`. Members
 * reach them through includeHtml; a Run's coordinator, refused HTML, does not.
 */
export const MAIL_READ_LINKS_MAX_BYTES = 8_000;

/** Longer hrefs are click-tracking redirects, left out of compact reads. */
export const MAIL_READ_LINK_HREF_MAX_BYTES = 512;

const MAIL_ADDRESSING_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "delivered-to",
  "reply-to",
  "sender",
]);

/** Any of these means the copy travelled through another mailbox first. */
export function isMailForwardingHeader(name: string): boolean {
  const key = name.toLowerCase();
  return (
    key.startsWith("x-forwarded-") ||
    key.startsWith("resent-") ||
    key === "x-google-original-from"
  );
}

/**
 * Addressing headers plus every forwarding header (prefix-matched, so a new
 * `x-forwarded-*` or `resent-*` form is never dropped) and any `also` names.
 * Transport headers (DKIM, ARC, Received) are kilobytes of noise to a reader,
 * while a dropped forwarding header would make a forwarded copy look direct.
 */
export function mailAttributionHeaders(
  headers: Record<string, string> | undefined,
  also: readonly string[] = [],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name, value]) =>
        value.trim() !== "" &&
        (MAIL_ADDRESSING_HEADERS.has(name) ||
          isMailForwardingHeader(name) ||
          also.includes(name)),
    ),
  );
}

/**
 * What a read returns: the body as compact text (HTML converted when the text
 * part is empty or poorer), or, when `includeHtml` pages it, one raw HTML page
 * in place of that text.
 */
export const mailReadContent = z.object({
  snippet: z.string().nullable(),
  /** The hidden inbox summary before the visible body, from the HTML. */
  preheader: z.string().nullable().default(null),
  bodyText: z.string().nullable(),
  /** UTF-8 size of the whole compact body that `bodyText` pages. */
  textBytes: z.number().int().nullable().default(null),
  /** One raw HTML page, only when `includeHtml` asked for it. */
  bodyHtml: z.string().nullable(),
  /** Exact `offset` of the next page of `bodyText` (or of the HTML page when
   * `includeHtml`); null at the end. */
  nextOffset: z.number().int().nullable(),
  headers: z.record(z.string(), z.string()).optional(),
  /** UTF-8 size of the stored HTML body. */
  htmlBytes: z.number().int().nullable(),
  /** `bodyText` was converted from the HTML body. */
  compacted: z.boolean(),
  /** More compact pages follow (`nextOffset`), the compact text lost
   * purchase evidence, or the HTML page is a fragment of the original. */
  truncated: z.boolean(),
  /** Cue-bearing links first, from the HTML body. */
  links: z.array(z.object({ href: z.string(), text: z.string() })).default([]),
  /** Links left out to keep the read under MAIL_READ_RESPONSE_MAX_BYTES. */
  linksOmitted: z.number().int().min(0).default(0),
  /** Content images (purchase-cue images first) with their exact `src`. */
  images: z.array(z.object({ src: z.string(), alt: z.string() })).default([]),
  imagesOmitted: z.number().int().min(0).default(0),
  /** Whole JSON-LD or microdata blocks the HTML declares. */
  structuredData: z.array(z.string()).default([]),
  structuredDataOmitted: z.number().int().min(0).default(0),
  /** `headers` left out because they alone overflow the response cap. */
  headersOmitted: z.boolean().default(false),
  /** The body text or HTML page was cut further to fit the response cap;
   * an HTML read continues from `nextOffset`. */
  bodyShortened: z.boolean().default(false),
});
export type MailReadContent = z.infer<typeof mailReadContent>;

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
      shipments: z
        .array(
          z.object({
            purchaseId: purchaseShortcode,
            shipments: z.array(shipmentEvidence).min(1).max(50),
          }),
        )
        .max(50)
        .optional()
        .describe(
          "Package observations from this exact Email, each assigned to one of purchaseIds. No money or inventory writes.",
        ),
      settlement: mailSettlementReview.optional(),
      via: mailAdmissionPath.optional(),
    })
    .refine(
      (value) =>
        value.shipments?.every((packet) =>
          value.purchaseIds.includes(packet.purchaseId),
        ) ?? true,
      {
        message: "Shipment packets must name a linked Purchase.",
        path: ["shipments"],
      },
    )
    .refine((value) => !value.settlement || value.event === "refunded", {
      message: "Settlement evidence requires a refunded lifecycle event.",
      path: ["settlement"],
    })
    .describe(
      "The Email records this lifecycle event of existing Purchases. Writes no Expenses.",
    ),
  z
    .object({
      kind: z.literal("financial"),
      transactionId: financialTransactionShortcode,
      reason: z.string().trim().min(1).max(1_000),
      review: z
        .strictObject({
          reviewedAccountId: financialAccountShortcode,
          sourceAccountLabel: z.string().trim().min(1).max(320),
        })
        .optional()
        .describe(
          "A member's review: the transaction's account and its label as the Email shows it. Pi omits it.",
        ),
    })
    .describe(
      "The Email evidences this existing posted Financial Transaction without a Purchase: a transfer, incoming payment, reimbursement, card repayment or refund. Writes no spending. A member supplies the reviewed account. A Mail import Run may reuse only a current member-accepted Email/checksum/transaction/account association with matching event amount and direction; unqualified provider identifier equality does not establish cross-provider identity.",
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
    "The checksum purchase_import_read.mail_read returned for this Email.",
  ),
  disposition: mailResolveDisposition,
});
export type MailResolveInput = z.infer<typeof mailResolveInput>;

export const mailResolveOut = mailMessageRef.extend({
  status: emailStatus,
  disposition: z.enum(["linked", "financial", "unresolved", "unrelated"]),
  purchaseIds: z.array(purchaseShortcode),
  financialAssociations: z.array(mailFinancialAssociation),
});
export const MAIL_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
/** A retained attachment's original bytes, read through `purchase_import_read.mail_read`. */
export const mailAttachmentOriginal = z.strictObject({
  attachmentId: z.string().min(1).max(200),
  filename: z.string().max(1_000),
  mimeType: z.string().regex(/^(?:application\/pdf|image\/[A-Za-z0-9.+-]+)$/u),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  dataBase64: z.string().max(Math.ceil(MAIL_ATTACHMENT_MAX_BYTES / 3) * 4),
});
export type MailAttachmentOriginal = z.infer<typeof mailAttachmentOriginal>;

/**
 * The text the purchase agent receives for a tool result: the result as JSON
 * with an original attachment's bytes moved out to media. The agent adapter
 * emits exactly this and the Email read cap measures exactly this.
 */
export function mailReadAgentText<
  T extends { originalAttachment?: MailAttachmentOriginal | undefined },
>(result: T): string {
  if (!result.originalAttachment) return JSON.stringify(result);
  const { dataBase64: _bytes, ...descriptor } = result.originalAttachment;
  return JSON.stringify({ ...result, originalAttachment: descriptor });
}

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
  /** The Email's EML- code: what purchase_import.email_import and purchase_import.email_purchase_decide take. */
  id: emailShortcode,
  threadId: z.string().nullable(),
  checksum: sha256,
  sender: z.string().nullable(),
  subject: z.string().nullable(),
  receivedAt: z.iso.datetime().nullable(),
  content: mailReadContent,
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
        /** Null when a deleted Purchase was accepted before observations named it. */
        purchaseId: purchaseShortcode.nullable(),
        purchaseDeleted: z.boolean(),
        source: importSourceIdentity,
      }),
    )
    .default([]),
  financialAssociations: z.array(mailFinancialAssociation).default([]),
});
export type MailReadOut = z.infer<typeof mailReadOut>;
export const mailSearchOut = z.object({
  status: z.enum(["ok", "mailbox_required", "gmail_reconnect_required"]),
  mailboxes: z.array(z.string()),
  messages: z.array(
    mailMessageRef.extend({
      /** With `checksum`, the exact selection purchase_import.email_import takes. */
      id: emailShortcode,
      checksum: sha256,
      threadId: z.string().nullable(),
      classification: mailboxClassification.nullable(),
      status: emailStatus,
      sender: z.string().nullable(),
      subject: z.string().nullable(),
      receivedAt: z.iso.datetime().nullable(),
      /**
       * The Run processing this Email, if any. Another live Run's Email cannot be
       * admitted here; name the holder instead of calling it "not admitted".
       */
      heldBy: z
        .object({ run: runShortcode, status: z.string() })
        .nullable()
        .default(null),
    }),
  ),
  /** Matches whose evidence write lost a contention race; search again to retry. */
  retryableMessageIds: z.array(z.string()).default([]),
  nextPageToken: z.string().nullable(),
});

/** Stored execution evidence is separate from the Email's later state. */
export const discoveryEmailReceipt = z.object({
  id: emailShortcode,
  emailId: entityIdSchema("email"),
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

const QUERY_SAMPLE = 10;
/** A bounded view of a long query list: counts plus the first few entries. */
export const mailboxQueryListSummary = z.object({
  total: z.number().int().nonnegative(),
  sample: z.array(mailboxScopedQuery).max(QUERY_SAMPLE),
});
export const mailboxCoverageSummary = mailboxCoverage
  .omit({ scoped: true })
  .extend({
    scoped: z.object({
      total: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      /** The next pending queries in search order. */
      nextPending: z.array(scopedQueryPosition).max(QUERY_SAMPLE),
    }),
  });
export const mailboxDiscoveryProgressSummary = mailboxDiscoveryProgress
  .omit({ page: true })
  .extend({
    page: z
      .object({
        messageCount: z.number().int().nonnegative(),
        eventCount: z.number().int().nonnegative(),
      })
      .nullable(),
  });

export const summarizeQueryList = (
  queries: readonly MailboxScopedQuery[],
): z.infer<typeof mailboxQueryListSummary> => ({
  total: queries.length,
  sample: queries
    .slice(0, QUERY_SAMPLE)
    .map(({ key, query }) => ({ key, query })),
});
export const summarizeMailboxCoverage = ({
  scoped,
  ...coverage
}: MailboxCoverage): z.infer<typeof mailboxCoverageSummary> => {
  const pending = scoped.filter((query) => !query.completed);
  return {
    ...coverage,
    scoped: {
      total: scoped.length,
      completed: scoped.length - pending.length,
      pending: pending.length,
      nextPending: pending.slice(0, QUERY_SAMPLE),
    },
  };
};
export const summarizeDiscoveryProgress = ({
  page,
  ...progress
}: z.infer<typeof mailboxDiscoveryProgress>): z.infer<
  typeof mailboxDiscoveryProgressSummary
> => ({
  ...progress,
  page: page
    ? { messageCount: page.messageIds.length, eventCount: page.events.length }
    : null,
});

export {
  mailSearchState,
  MAIL_SEARCH_STATE_LABEL,
  type MailSearchState,
} from "./mail-search-fields";

/**
 * The stored position of a current search, or undefined. A changed query text
 * restarts the search (`mergeMailboxQueries`), so its old position is not it.
 */
export const currentScopedPosition = (
  coverage: MailboxCoverage | null,
  query: MailboxScopedQuery,
  completedSearches?: ReadonlyMap<string, MailboxScopedPosition>,
): MailboxScopedPosition | undefined => {
  const position = coverage?.scoped.find(
    (entry) => entry.key === query.key && entry.query === query.query,
  );
  const receipt = completedSearches?.get(query.query);
  if (
    receipt &&
    !(
      position?.completedAt &&
      position.completedAt > (receipt.completedAt ?? "")
    )
  ) {
    const saved = coverage?.scoped.find(
      (entry) =>
        entry.key === receipt.key &&
        entry.query === query.query &&
        entry.completed,
    );
    return saved ?? receipt;
  }
  return position;
};

export const scopedPositionState = (
  position: MailboxScopedPosition | undefined,
): MailSearchState =>
  position?.completed
    ? "done"
    : position?.pageToken
      ? "in_progress"
      : "not_started";

/** `vendor:<uuid>:…` searches a known Vendor's senders; `merchant:`/`descriptor:` search an unmatched charge. */
export const isVendorMailSearchKey = (key: string) => key.startsWith("vendor:");

const PENDING_SAMPLE = 5;
const searchCount = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
/** One mailbox's targeted-search progress over the current targets only. */
export const mailSearchProgress = z.strictObject({
  vendors: searchCount,
  charges: searchCount,
  /** The search part-way through its pages, if any. */
  inProgress: mailboxScopedQuery.nullable(),
  /** The next untouched searches in search order. */
  nextPending: z.array(mailboxScopedQuery).max(PENDING_SAMPLE),
});
export type MailSearchProgress = z.infer<typeof mailSearchProgress>;

/**
 * Counts and the search queue for one mailbox. Stored entries that are no
 * longer targets (kept so a returning target is not rescanned) are ignored;
 * targets not yet merged into the cursor queue after the stored ones, as the
 * next merge appends them.
 */
export const summarizeMailSearchProgress = (
  coverage: MailboxCoverage | null,
  targets: readonly MailboxScopedQuery[],
): MailSearchProgress => {
  const states = targets.map((query) => ({
    query,
    state: scopedPositionState(currentScopedPosition(coverage, query)),
  }));
  const count = (vendor: boolean) => {
    const group = states.filter(
      ({ query }) => isVendorMailSearchKey(query.key) === vendor,
    );
    return {
      completed: group.filter(({ state }) => state === "done").length,
      total: group.length,
    };
  };
  const stored = new Map(
    (coverage?.scoped ?? []).map((entry, index) => [entry.key, index]),
  );
  const queue = states
    .filter(({ state }) => state !== "done")
    .map(({ query, state }) => ({
      query: { key: query.key, query: query.query },
      state,
      order: stored.get(query.key) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => left.order - right.order);
  const inProgress =
    queue.find(({ state }) => state === "in_progress")?.query ?? null;
  return {
    vendors: count(true),
    charges: count(false),
    inProgress,
    nextPending: queue
      .filter(({ state }) => state === "not_started")
      .slice(0, PENDING_SAMPLE)
      .map(({ query }) => query),
  };
};
