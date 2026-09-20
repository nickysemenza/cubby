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

const extractedOrderCandidate = z.object({
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

export const importExtractionOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    candidate: extractedOrderCandidate,
  }),
  z.object({
    status: z.literal("needs_review"),
    candidate: extractedOrderCandidate,
    reason: z.enum([
      "sum_mismatch",
      "foreign_currency",
      "missing_total",
      "ambiguous_order",
    ]),
    detail: z.string().trim().min(1).max(2_000),
  }),
  z.object({
    status: z.literal("unreadable"),
    candidate: extractedOrderCandidate.optional(),
    detail: z.string().trim().min(1).max(2_000),
  }),
]);
export type ImportExtractionOutcome = z.infer<typeof importExtractionOutcome>;

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
