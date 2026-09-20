import { z } from "zod";

import { money } from "./money";
import { expenseLineKindSchema } from "./expense-line-kind";
import {
  imageShortcode,
  purchaseShortcode,
  vendorShortcode,
  vendorAccountShortcode,
} from "./identifier-fields";

export const vendorOrderEvidence = z.enum([
  "online_account",
  "receipt_only",
  "not_expected",
]);
export type VendorOrderEvidence = z.infer<typeof vendorOrderEvidence>;

export const importSourceKind = z.enum([
  "browser_order",
  "mail_message",
  "mail_attachment",
  "receipt_photo",
  "vendor_export",
]);
export type ImportSourceKind = z.infer<typeof importSourceKind>;

export const importRunTrigger = z.enum([
  "foreground",
  "discovery",
  "manual",
  "backfill",
]);
export type ImportRunTrigger = z.infer<typeof importRunTrigger>;

export const importRunStatus = z.enum([
  "running",
  "paused_auth",
  "paused_offline",
  "needs_review",
  "completed",
  "failed",
]);
export type ImportRunStatus = z.infer<typeof importRunStatus>;

export const importSourceIdentity = z.object({
  kind: importSourceKind,
  externalKey: z.string().trim().min(1).max(512),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ImportSourceIdentity = z.infer<typeof importSourceIdentity>;

export const extractedPurchaseLine = z.object({
  title: z.string().trim().min(1).max(500),
  amount: money,
  lineKind: expenseLineKindSchema.default("principal"),
  quantity: z.number().positive().finite().optional(),
  productUrl: z.url().optional(),
  imageUrl: z.url().optional(),
  sku: z.string().trim().min(1).max(200).optional(),
  seller: z.string().trim().min(1).max(300).optional(),
});
export type ExtractedPurchaseLine = z.infer<typeof extractedPurchaseLine>;

export const extractedPaymentEvidence = z.object({
  amount: money,
  chargedAt: z.iso.datetime().optional(),
  cardLastFour: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  description: z.string().trim().min(1).max(500).optional(),
});
export type ExtractedPaymentEvidence = z.infer<typeof extractedPaymentEvidence>;

export const extractedOrderCandidate = z.object({
  orderId: z.string().trim().min(1).max(300).nullable(),
  orderedAt: z.iso.datetime().nullable(),
  merchant: z.string().trim().min(1).max(300).nullable(),
  currency: z.string().trim().length(3),
  printedGrandTotal: money.nullable(),
  lines: z.array(extractedPurchaseLine).max(500),
  payments: z.array(extractedPaymentEvidence).max(100),
  allShipmentsDelivered: z.boolean().nullable(),
});
export type ExtractedOrderCandidate = z.infer<typeof extractedOrderCandidate>;

const importExtractionReviewReason = z.enum([
  "sum_mismatch",
  "foreign_currency",
  "missing_total",
  "ambiguous_order",
]);

export const importExtractionOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    candidate: extractedOrderCandidate,
  }),
  z.object({
    status: z.literal("needs_review"),
    candidate: extractedOrderCandidate,
    reason: importExtractionReviewReason,
    detail: z.string().trim().min(1).max(2_000),
  }),
  z.object({
    status: z.literal("unreadable"),
    candidate: extractedOrderCandidate.optional(),
    detail: z.string().trim().min(1).max(2_000),
  }),
]);
export type ImportExtractionOutcome = z.infer<typeof importExtractionOutcome>;

const extractedPurchaseLineModelOutput = z.object({
  title: z.string().trim().min(1).max(500),
  amount: money,
  lineKind: expenseLineKindSchema.nullable(),
  quantity: z.number().positive().finite().nullable(),
  productUrl: z.url().nullable(),
  imageUrl: z.url().nullable(),
  sku: z.string().trim().min(1).max(200).nullable(),
  seller: z.string().trim().min(1).max(300).nullable(),
});

const extractedPaymentEvidenceModelOutput = z.object({
  amount: money,
  chargedAt: z.iso.datetime().nullable(),
  cardLastFour: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  description: z.string().trim().min(1).max(500).nullable(),
});

const extractedOrderCandidateModelOutput = z.object({
  orderId: z.string().trim().min(1).max(300).nullable(),
  orderedAt: z.iso.datetime().nullable(),
  merchant: z.string().trim().min(1).max(300).nullable(),
  currency: z.string().trim().length(3),
  printedGrandTotal: money.nullable(),
  lines: z.array(extractedPurchaseLineModelOutput).max(500),
  payments: z.array(extractedPaymentEvidenceModelOutput).max(100),
  allShipmentsDelivered: z.boolean().nullable(),
});

/**
 * OpenAI structured outputs reject the `oneOf` emitted for a discriminated
 * union and require every object property. Keep the model wire shape as one
 * object with required nullable fields, then normalize it into the stricter
 * domain union above. In particular, optional line/payment properties must be
 * nullable on the wire because OpenAI emits them as explicit nulls.
 */
export const importExtractionModelOutput = z.object({
  status: z.enum(["ready", "needs_review", "unreadable"]),
  candidate: extractedOrderCandidateModelOutput.nullable(),
  reason: importExtractionReviewReason.nullable(),
  detail: z.string().trim().min(1).max(2_000).nullable(),
});
export type ImportExtractionModelOutput = z.infer<
  typeof importExtractionModelOutput
>;

export function normalizeImportExtractionModelOutput(
  output: ImportExtractionModelOutput,
): ImportExtractionOutcome {
  const candidate = output.candidate
    ? extractedOrderCandidate.parse({
        ...output.candidate,
        lines: output.candidate.lines.map((line) => {
          const normalized: ExtractedPurchaseLine = {
            title: line.title,
            amount: line.amount,
            lineKind: line.lineKind ?? "principal",
          };
          if (line.quantity !== null) normalized.quantity = line.quantity;
          if (line.productUrl !== null) normalized.productUrl = line.productUrl;
          if (line.imageUrl !== null) normalized.imageUrl = line.imageUrl;
          if (line.sku !== null) normalized.sku = line.sku;
          if (line.seller !== null) normalized.seller = line.seller;
          return normalized;
        }),
        payments: output.candidate.payments.map((payment) => {
          const normalized: ExtractedPaymentEvidence = {
            amount: payment.amount,
          };
          if (payment.chargedAt !== null)
            normalized.chargedAt = payment.chargedAt;
          if (payment.cardLastFour !== null)
            normalized.cardLastFour = payment.cardLastFour;
          if (payment.description !== null)
            normalized.description = payment.description;
          return normalized;
        }),
      })
    : null;
  if (output.status === "ready" && candidate) {
    return { status: "ready", candidate };
  }
  if (output.status === "needs_review" && candidate) {
    return {
      status: "needs_review",
      candidate,
      reason: output.reason ?? "ambiguous_order",
      detail: output.detail ?? "The extracted order needs review.",
    };
  }
  const detail =
    output.detail ?? "The captured order could not be read reliably.";
  if (candidate) return { status: "unreadable", candidate, detail };
  return { status: "unreadable", detail };
}

export const importFindingKind = z.enum([
  "wrong_product",
  "duplicate_product",
  "sum_mismatch",
  "duplicate_lines",
  "foreign_currency",
  "reversal_kind",
  "missing_line",
  "kit_double_booked",
  "variant_doubt",
  "arrived",
  "refund_unbooked",
  "return_window",
  "auth_required",
  "expected_order_not_found",
  "receipt_required",
  "unclassified_vendor",
  "other",
]);
export type ImportFindingKind = z.infer<typeof importFindingKind>;

export const importFindingStatus = z.enum(["open", "applied", "dismissed"]);

export const proposedImportFix = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replace_aggregate_line"),
    purchaseId: z.uuid(),
    lines: z.array(extractedPurchaseLine).min(1),
  }),
  z.object({
    kind: z.literal("relink_product"),
    expenseId: z.uuid(),
    productId: z.uuid(),
  }),
  z.object({
    kind: z.literal("receive_purchase"),
    purchaseId: z.uuid(),
  }),
  z.object({
    kind: z.literal("create_refund"),
    purchaseId: z.uuid(),
    amount: money.refine((value) => value < 0, "refund must be negative"),
    title: z.string().trim().min(1).max(500),
  }),
]);
export type ProposedImportFix = z.infer<typeof proposedImportFix>;

export const browserCapture = z.object({
  url: z.url(),
  title: z.string().max(500),
  text: z.string().max(24 * 1_024),
  links: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        href: z.url(),
        text: z.string().max(500),
      }),
    )
    .max(500),
  images: z
    .array(z.object({ src: z.url(), alt: z.string().max(500) }))
    .max(500),
  capturedAt: z.iso.datetime(),
});
export type BrowserCapture = z.infer<typeof browserCapture>;

export const purchaseImportNavigationDecision = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("follow_link"),
    linkId: z.string().min(1).max(200),
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({
    action: z.literal("scroll"),
    pageCount: z.number().int().min(1).max(10),
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({
    action: z.literal("finish"),
    reason: z.string().trim().min(1).max(500),
  }),
]);
export type PurchaseImportNavigationDecision = z.infer<
  typeof purchaseImportNavigationDecision
>;

export const orderMailClassification = z.object({
  event: z.enum(["placed", "shipped", "delivered", "refunded", "other"]),
  orderId: z.string().trim().min(1).max(300).nullable(),
  amount: money.nullable(),
  currency: z.string().trim().length(3).nullable(),
  occurredAt: z.iso.datetime().nullable(),
});
export type OrderMailClassification = z.infer<typeof orderMailClassification>;

const allowedBrowserHosts = z
  .array(z.string().trim().min(1).max(253))
  .min(1)
  .max(20);
export const browserBridgeOperation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    url: z.url(),
    allowedHosts: allowedBrowserHosts,
  }),
  z.object({
    type: z.literal("follow_captured_link"),
    linkID: z.string().min(1).max(200),
    allowedHosts: allowedBrowserHosts,
  }),
  z.object({
    type: z.literal("scroll"),
    pageCount: z.number().int().min(1).max(10),
  }),
  z.object({
    type: z.literal("capture"),
    allowedHosts: allowedBrowserHosts,
    enhancedEvidence: z.boolean(),
    // A capture remains restart-safe without giving the client broader browser authority. The
    // web service derives this URL from the run's claimed work; the Mac may use it only when its
    // dedicated window disappeared across an app/browser restart.
    recoveryURL: z.url().optional(),
  }),
]);
export type BrowserBridgeOperation = z.infer<typeof browserBridgeOperation>;
export const browserBridgeRequest = z.object({
  protocolVersion: z.literal(2),
  id: z.uuid(),
  operationId: z.string().trim().min(1).max(200),
  runID: z.string().trim().min(1).max(200),
  deadline: z.iso.datetime(),
  operation: browserBridgeOperation,
});
export type BrowserBridgeRequest = z.infer<typeof browserBridgeRequest>;

export const browserEvidenceKind = z.enum([
  "normalized_pdf",
  "rendered_pdf",
  "screenshot",
]);
export const browserEvidenceReference = z.object({
  id: z.string().min(1).max(500),
  kind: browserEvidenceKind,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().min(1).max(200),
});
export const browserCapturedLink = z.object({
  id: z.string(),
  url: z.url(),
  label: z.string().nullish(),
});
export const browserCapturedImage = z.object({
  url: z.url(),
  alt: z.string().nullish(),
});
export const browserPaymentEvidence = z.object({
  methodLabel: z.string().nullish(),
  lastFour: z.string().nullish(),
  amountText: z.string().nullish(),
});
export const browserPageCapture = z.object({
  sourceURL: z.url(),
  title: z.string().max(500),
  capturedAt: z.iso.datetime(),
  captureVersion: z.number().int().positive(),
  readableText: z.string().max(24 * 1_024),
  links: z.array(browserCapturedLink).max(200),
  images: z.array(browserCapturedImage).max(200),
  paymentEvidence: z.array(browserPaymentEvidence).max(100),
  evidence: z.array(browserEvidenceReference).max(10),
});
export const browserBridgeFailureCode = z.enum([
  "cancelled",
  "deadline_exceeded",
  "invalid_command",
  "disallowed_url",
  "unknown_link",
  "browser_unavailable",
  "browser_permission_denied",
  "authentication_required",
  "capture_unavailable",
  "upload_failed",
  "execution_failed",
]);
export const browserBridgeCommandOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    capture: browserPageCapture.nullable().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    code: browserBridgeFailureCode,
    message: z.string().max(2_000),
    retryable: z.boolean(),
  }),
]);
export const browserBridgeResult = z.object({
  protocolVersion: z.literal(2),
  // Foundation encodes UUID values uppercase. Normalize at the protocol
  // boundary because Durable Object SQLite command keys are lowercase text.
  commandID: z.uuid().toLowerCase(),
  operationID: z.string().trim().min(1).max(200),
  runID: z.string().min(1).max(200),
  completedAt: z.iso.datetime(),
  outcome: browserBridgeCommandOutcome,
});
export type BrowserBridgeResult = z.infer<typeof browserBridgeResult>;

export const browserChoice = z.enum(["chrome", "safari"]);
export const browserBridgeCapabilities = z.object({
  fixedCaptureVersion: z.number().int().positive(),
  enhancedScreenshot: z.boolean(),
  renderedPDF: z.boolean(),
});
export const browserBridgeClientMessage = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("hello"),
    deviceID: z.uuid(),
    browser: browserChoice,
    capabilities: browserBridgeCapabilities,
  }),
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("result"),
    result: browserBridgeResult,
  }),
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("pong"),
    timestamp: z.iso.datetime(),
  }),
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("run_completed_ack"),
    runID: z.uuid(),
  }),
]);
export const browserBridgeRunCompletion = z.object({
  runID: z.uuid(),
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  findingCount: z.number().int().nonnegative(),
});
export const browserBridgeServerMessage = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("command"),
    command: browserBridgeRequest,
  }),
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("acknowledge"),
    commandID: z.uuid(),
  }),
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("cancel"),
    commandID: z.uuid(),
  }),
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("ping"),
    timestamp: z.iso.datetime(),
  }),
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("raise_auth_window"),
    runID: z.uuid(),
  }),
  z.object({
    protocolVersion: z.literal(2),
    type: z.literal("run_completed"),
    ...browserBridgeRunCompletion.shape,
  }),
]);

export const purchaseAgentEvent = z.object({
  version: z.literal(1),
  runId: z.uuid(),
  eventId: z.string().trim().min(1).max(256),
  type: z.enum([
    "start_or_resume",
    "browser_connected",
    "browser_result",
    "retry",
  ]),
  commandId: z.uuid().optional(),
  connectionId: z.string().trim().min(1).max(256).optional(),
  retryOf: z.string().trim().min(1).max(256).optional(),
});
export type PurchaseAgentEvent = z.infer<typeof purchaseAgentEvent>;

export const purchaseImportRunScope = z.object({
  runId: z.uuid(),
  agentId: z.string().trim().min(1),
  trigger: importRunTrigger,
  status: importRunStatus,
  vendorAccountId: z.uuid().nullable(),
  vendorLabel: z.string().trim().min(1).max(500).nullable(),
  allowedHosts: z.array(z.string().trim().min(1).max(253)).max(20),
  navigationHints: z.unknown(),
});
export type PurchaseImportRunScope = z.infer<typeof purchaseImportRunScope>;

export const importWriterInput = z.object({
  runId: z.uuid(),
  ledgerPartyId: z.uuid(),
  vendorId: z.uuid(),
  vendorAccountId: z.uuid().nullable(),
  source: importSourceIdentity,
  extraction: importExtractionOutcome,
  primaryDocumentImageId: z.uuid().nullable(),
  screenshotImageId: z.uuid().nullable(),
});
export type ImportWriterInput = z.infer<typeof importWriterInput>;

export const importWriterOutput = z.object({
  outcome: z.enum(["created", "updated", "replayed", "conflict"]),
  purchaseId: z.uuid().nullable(),
  findingIds: z.array(z.uuid()),
  outputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ImportWriterOutput = z.infer<typeof importWriterOutput>;

export const importVendorOrdersInput = z.object({
  vendorAccountId: vendorAccountShortcode,
  orders: z
    .array(
      z.object({
        source: importSourceIdentity,
        extraction: importExtractionOutcome,
        primaryDocumentImageId: imageShortcode.nullable().default(null),
        screenshotImageId: imageShortcode.nullable().default(null),
      }),
    )
    .min(1)
    .max(50),
});
export type ImportVendorOrdersInput = z.infer<typeof importVendorOrdersInput>;

export const importVendorOrdersOut = z.object({
  items: z.array(
    z.object({
      outcome: importWriterOutput.shape.outcome,
      purchaseId: purchaseShortcode.nullable(),
      findingCount: z.number().int().nonnegative(),
    }),
  ),
});

export const confirmMerchantVendorRuleInput = z.object({
  merchant: z.string().trim().min(1).max(500),
  vendorId: vendorShortcode,
});
export type ConfirmMerchantVendorRuleInput = z.infer<
  typeof confirmMerchantVendorRuleInput
>;
export const confirmMerchantVendorRuleOut = z.object({
  normalizedMerchant: z.string(),
  vendorId: vendorShortcode,
});

export const submitReceiptEvidenceInput = z.object({
  huntId: z.uuid(),
  imageId: imageShortcode,
});
export type SubmitReceiptEvidenceInput = z.infer<
  typeof submitReceiptEvidenceInput
>;
export const submitReceiptEvidenceOut = z.object({
  huntId: z.uuid(),
  imageId: imageShortcode,
  queued: z.boolean(),
});

export const listReceiptHuntsInput = z.object({});
export const listReceiptHuntsOut = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      transactionDate: z.iso.date(),
      merchant: z.string().nullable(),
      amountInCents: z.number().int().nonnegative(),
    }),
  ),
});

export const importAuditFinding = z.object({
  kind: importFindingKind,
  targetPurchaseId: z.uuid(),
  summary: z.string().trim().min(1).max(1_000),
  probability: z.number().finite().min(0).max(1),
  proposedFix: proposedImportFix.nullable(),
});

export const importAuditOutput = z.object({
  findings: z.array(importAuditFinding).max(100),
});
export type ImportAuditOutput = z.infer<typeof importAuditOutput>;
