import { tradeSchema } from "./task-fields";
import { z } from "zod";
import { productCategoryShortcode } from "./identifier-fields";
import { externalIdKind, externalIdSource } from "./external-id";
import { agentImportRunPurpose } from "./import-run-agent";

import { money } from "./money";
import { runPurpose, runStatus, runTrigger } from "./run-fields";
import { expenseLineKindSchema } from "./expense-line-kind";
import {
  imageShortcode,
  expenseShortcode,
  productShortcode,
  projectShortcode,
  runEntityId,
  runShortcode,
  purchaseShortcode,
  vendorShortcode,
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

export { runPurpose, runStatus, runTrigger } from "./run-fields";
export type RunTrigger = z.infer<typeof runTrigger>;
export type RunStatus = z.infer<typeof runStatus>;
export type RunPurpose = z.infer<typeof runPurpose>;

export const runTargetKind = z.enum(["purchase", "product"]);
export type RunTargetKind = z.infer<typeof runTargetKind>;

export const runTargetState = z.enum([
  "pending",
  "prepared",
  "completed",
  "skipped",
  "unresolved",
  "needs_evidence",
  "unavailable",
]);
export type RunTargetState = z.infer<typeof runTargetState>;

/**
 * How every client counts a run's targets: done, skipped (the member need not
 * act), blocked (waiting on the member or on evidence), or still to do.
 */
export const RUN_TARGET_BUCKET = {
  pending: "pending",
  prepared: "pending",
  completed: "completed",
  skipped: "skipped",
  unavailable: "skipped",
  unresolved: "blocked",
  needs_evidence: "blocked",
} as const satisfies Record<
  RunTargetState,
  "completed" | "skipped" | "blocked" | "pending"
>;
export type RunTargetBucket = (typeof RUN_TARGET_BUCKET)[RunTargetState];

export function countRunTargets(states: readonly RunTargetState[]) {
  const counts = { total: 0, completed: 0, skipped: 0, blocked: 0, pending: 0 };
  for (const state of states) {
    counts.total += 1;
    counts[RUN_TARGET_BUCKET[state]] += 1;
  }
  return counts;
}

export const runTargetOutcome = z.enum([
  "replayed",
  "raw_evidence_drift",
  "semantic_drift",
  "enriched",
  "unavailable",
  "skipped",
]);
export type RunTargetOutcome = z.infer<typeof runTargetOutcome>;

export const runEvidenceKind = z.enum([
  "browser_capture",
  "gmail_attachment",
  "manual_upload",
]);
export type RunEvidenceKind = z.infer<typeof runEvidenceKind>;

export { runShortcode };
export type RunPublicId = z.infer<typeof runShortcode>;

/** Stage bytes for a run target only; this never creates an Image or Document. */
export const initiateRunEvidenceUploadInput = z.object({
  // The run's public code: the browser page names runs by it and the Mac
  // echoes the one its capture command's evidence scope carried.
  runId: runShortcode,
  targetId: z.uuid(),
  kind: runEvidenceKind,
  contentType: z.enum([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
    "image/heic",
    "image/heif",
  ]),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  filename: z.string().trim().min(1).max(255),
  sourceMetadata: z.record(z.string(), z.json()).default({}),
});
export type InitiateRunEvidenceUploadInput = z.infer<
  typeof initiateRunEvidenceUploadInput
>;

export const initiateRunEvidenceUploadOut = z.object({
  evidenceId: z.uuid(),
  objectKey: z.string().min(1),
  uploadUrl: z.url(),
  expiresAt: z.iso.datetime(),
});
export type InitiateRunEvidenceUploadOut = z.infer<
  typeof initiateRunEvidenceUploadOut
>;

const targetedSource = z.object({
  kind: importSourceKind,
  externalKey: z.string().trim().min(1).max(512),
});

export const purchaseValidationTargetInput = z.object({
  purchaseId: purchaseShortcode,
  vendorAccountId: z.uuid().nullable().optional(),
  source: targetedSource.nullable().optional(),
  targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const createPurchaseValidationRunInput = z.object({
  vendorId: vendorShortcode,
  vendorAccountId: z.uuid().nullable().optional(),
  trigger: runTrigger.default("manual"),
  targets: z.array(purchaseValidationTargetInput).min(1).max(50),
});
export type CreatePurchaseValidationRunInput = z.infer<
  typeof createPurchaseValidationRunInput
>;

export const productEnrichmentTargetInput = z.object({
  productId: productShortcode,
  vendorAccountId: z.uuid().nullable().optional(),
  source: targetedSource.nullable().optional(),
  targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const createProductEnrichmentRunsInput = z.object({
  vendorId: vendorShortcode,
  trigger: runTrigger.default("manual"),
  targets: z.array(productEnrichmentTargetInput).min(1).max(50),
});
export type CreateProductEnrichmentRunsInput = z.infer<
  typeof createProductEnrichmentRunsInput
>;

export const targetedRunStartOut = z.object({
  created: z.boolean(),
  run: z
    .object({
      id: runShortcode,
      status: runStatus,
      purpose: runPurpose,
      dispatchEventId: z.string().uuid().nullable(),
    })
    .nullable(),
  blockingRun: z.object({ id: runShortcode, status: runStatus }).nullable(),
});

const importOperationId = z.string().trim().min(1).max(200);
const importItemOperationId = z.string().trim().min(1).max(200);
const stableImportItemId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

/**
 * Stable execution identity is deliberately separate from the payload hash.
 * Reusing an operation id with changed arguments is a fenced conflict, while
 * retrying it verbatim returns the original ledger result.
 */
export const purchaseImportRunExecution = z.object({
  // The private run id: it is what the delegation token and agent instance
  // carry, so the public code can change without touching agent state.
  runId: z.uuid(),
  operationId: importOperationId,
  itemOperationIds: z.array(importItemOperationId).min(1).max(50).optional(),
});
export type PurchaseImportRunExecution = z.infer<
  typeof purchaseImportRunExecution
>;

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
  lines: z.array(extractedPurchaseLineModelOutput),
  payments: z.array(extractedPaymentEvidenceModelOutput),
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

export const runFindingKind = z.enum([
  "wrong_product",
  "duplicate_product",
  "sum_mismatch",
  "duplicate_lines",
  "foreign_currency",
  "reversal_kind",
  "missing_line",
  "kit_double_booked",
  "variant_doubt",
  "product_unresolved",
  "arrived",
  "refund_unbooked",
  "return_window",
  "auth_required",
  "expected_order_not_found",
  "receipt_required",
  "unclassified_vendor",
  "other",
]);
export type RunFindingKind = z.infer<typeof runFindingKind>;

export const runFindingStatus = z.enum(["open", "applied", "dismissed"]);

export const replacementLineIdentity = z.object({
  productId: z.uuid().nullable(),
  promote: z.boolean(),
  /** An explicit expense-only decision: the line is not a stocked item. */
  expenseOnly: z.boolean().default(false),
  variantDoubt: z.boolean(),
  unresolvedReason: z.string().nullable(),
  probability: z.number(),
  lineKind: expenseLineKindSchema,
  kitKind: z.enum(["kit_with_components", "single", "n_pack"]),
  reversalKind: z
    .enum(["return", "concession", "cancellation", "replacement"])
    .nullable(),
});

export const replacementLineAttribution = z.object({
  lineIndex: z.number().int().nonnegative(),
  role: z.enum(["beneficiary", "funder"]),
  partyId: z.uuid().nullable(),
  partyCode: z.string(),
  amount: money,
  weight: z.number().int().positive().safe(),
});

export const aggregateReplacementSnapshot = z.object({
  fingerprint: z.string(),
  expenseCode: expenseShortcode,
  title: z.string(),
  amount: money,
  notes: z.string().nullable(),
  date: z.string().nullable(),
  projectName: z.string().nullable(),
  categoryName: z.string().nullable(),
  costType: z.string(),
  trade: z.string().nullable(),
  bookingTransactionCode: z.string().nullable(),
});

export const proposedImportFix = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replace_aggregate_line"),
    purchaseId: z.uuid(),
    // No `.min(1)`: this shape is the auditor model's output and Anthropic
    // structured outputs reject array bounds. `applyFix` refuses an empty
    // roster instead.
    lines: z.array(extractedPurchaseLine),
    // Auditor suggestions cannot authorize replacing a live ledger row. The
    // server adds the review snapshot and cent-preserving attribution preview.
    reviewSnapshot: aggregateReplacementSnapshot.optional(),
    reviewedLineIdentities: z.array(replacementLineIdentity).optional(),
    reviewedLineAttributions: z.array(replacementLineAttribution).optional(),
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

export const orderMailMessageClassification = z.object({
  events: z.array(orderMailClassification).max(50),
});
export type OrderMailMessageClassification = z.infer<
  typeof orderMailMessageClassification
>;

const allowedBrowserHosts = z
  .array(z.string().trim().min(1).max(253))
  .min(1)
  .max(20);
/**
 * The bridge protocol. The Mac is a thin browser hand: it opens allowlisted
 * URLs, scrolls, raises its window, and captures the page's trimmed DOM (and a
 * screenshot when asked). It reports what it saw (`browserObservation`) and
 * never interprets the page; the server derives every fact from the DOM.
 */
export const BROWSER_BRIDGE_PROTOCOL = 3;
const bridgeProtocol = z.literal(BROWSER_BRIDGE_PROTOCOL);

export const browserBridgeOperation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    url: z.url(),
    allowedHosts: allowedBrowserHosts,
  }),
  z.object({
    type: z.literal("scroll"),
    pageCount: z.number().int().min(1).max(10),
  }),
  z.object({
    type: z.literal("capture"),
    allowedHosts: allowedBrowserHosts,
    /**
     * `required`: the capture fails without one (purchase documents).
     * `preferred`: take one when the window is capturable, otherwise report
     * why and still return the DOM. `skip`: DOM only.
     */
    screenshot: z.enum(["required", "preferred", "skip"]),
    // The web service derives this URL from the run's claimed work; the Mac
    // uses it only when it cannot find its account window.
    recoveryURL: z.url().optional(),
    // Targeted browser evidence must retain the scope that authorizes its R2
    // upload; account-sync screenshots become purchase documents instead.
    evidenceScope: z
      .object({ runId: runShortcode, targetId: z.uuid() })
      .optional(),
  }),
  z.object({
    type: z.literal("window"),
    // `raise` brings the account window forward (sign-in, a capture that
    // needs it visible); `background` returns it behind the member's work.
    action: z.enum(["raise", "background"]),
  }),
]);
export type BrowserBridgeOperation = z.infer<typeof browserBridgeOperation>;
export const browserBridgeRequest = z.object({
  protocolVersion: bridgeProtocol,
  id: z.uuid(),
  operationId: z.string().trim().min(1).max(200),
  runID: z.string().trim().min(1).max(200),
  deadline: z.iso.datetime(),
  operation: browserBridgeOperation,
});
export type BrowserBridgeRequest = z.infer<typeof browserBridgeRequest>;

export const browserEvidenceKind = z.enum(["rendered_pdf", "screenshot"]);
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
  naturalWidth: z.number().int().positive().nullish(),
  naturalHeight: z.number().int().positive().nullish(),
  highResolutionUrl: z.url().nullish(),
});
export const browserPaymentEvidence = z.object({
  methodLabel: z.string().nullish(),
  lastFour: z.string().nullish(),
  amountText: z.string().nullish(),
});
const structuredIdentifierValues = z
  .array(z.string().trim().min(1).max(100))
  .max(10)
  .default([]);
/**
 * One schema.org Product node's identifier fields, read verbatim from the
 * page's `application/ld+json` block (never from page text). `gtins` merges
 * `gtin` and `gtin8/12/13/14`.
 */
export const browserStructuredProduct = z.object({
  skus: structuredIdentifierValues,
  mpns: structuredIdentifierValues,
  gtins: structuredIdentifierValues,
  productIds: structuredIdentifierValues,
});
export const browserStructuredProducts = z.object({
  products: z.array(browserStructuredProduct).max(20),
  /** A ProductGroup (or its variants) was present: no single variant is shown. */
  variantGroup: z.boolean(),
});
export type BrowserStructuredProducts = z.infer<
  typeof browserStructuredProducts
>;

/**
 * What the server derives from a captured DOM (`derivePageCapture`). It is
 * never sent by the Mac: the derivation revision replaces the old Mac capture
 * version, so improving it needs no Mac release and re-reads stored evidence.
 */
export const browserPageCapture = z.object({
  sourceURL: z.url(),
  canonicalUrl: z.url().nullish(),
  requestedAmazonAsin: z
    .string()
    .regex(/^[A-Z0-9]{10}$/iu)
    .nullish(),
  servedAmazonAsin: z
    .string()
    .regex(/^[A-Z0-9]{10}$/iu)
    .nullish(),
  variantMarkers: z
    .array(z.string().trim().min(1).max(500))
    .max(50)
    .default([]),
  title: z.string().max(500),
  capturedAt: z.iso.datetime(),
  captureVersion: z.number().int().positive(),
  readableText: z.string().max(24 * 1_024),
  links: z.array(browserCapturedLink).max(200),
  images: z.array(browserCapturedImage).max(200),
  paymentEvidence: z.array(browserPaymentEvidence).max(100),
  evidence: z.array(browserEvidenceReference).max(10),
  structuredProducts: browserStructuredProducts.nullish(),
  /** The page asks for a password: the vendor wants a sign-in. */
  authenticationRequired: z.boolean().default(false),
});
export type BrowserPageCapture = z.infer<typeof browserPageCapture>;

/** Why the Mac could not take a screenshot of its account window. */
export const browserScreenshotGap = z.enum([
  "window_not_found",
  "window_minimized",
  "window_off_screen",
  "screen_recording_denied",
  "capture_failed",
  "upload_failed",
]);

/**
 * What the Mac saw when it finished (or failed) a command. Every result
 * carries one, so a stall always says why: the run log and the Runs UI read
 * it, and the server's recovery policy acts on it.
 */
export const browserObservation = z.object({
  url: z.url().nullable(),
  title: z.string().max(500).nullable(),
  readyState: z.enum(["loading", "interactive", "complete"]).nullable(),
  window: z
    .object({
      /** Re-found by its tab marker after an app or browser relaunch. */
      recovered: z.boolean(),
      minimized: z.boolean().nullable(),
      onScreen: z.boolean().nullable(),
    })
    .nullable(),
  screenRecording: z.enum(["granted", "denied", "unknown"]),
  durationMs: z.number().int().nonnegative(),
});
export type BrowserObservation = z.infer<typeof browserObservation>;

/** Bytes the Mac sends inline: scripts, styles, SVG, and input values removed. */
export const BROWSER_DOM_MAX_ENCODED = 1_000_000;
export const browserPageSnapshot = z.object({
  sourceURL: z.url(),
  title: z.string().max(500),
  capturedAt: z.iso.datetime(),
  dom: z.object({
    encoding: z.literal("deflate-raw+base64"),
    data: z.string().min(1).max(BROWSER_DOM_MAX_ENCODED),
    /** Uncompressed UTF-8 byte length. */
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** The trimmed DOM still exceeded the limit and lost its tail. */
    truncated: z.boolean(),
  }),
  screenshot: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("captured"),
      evidence: z.array(browserEvidenceReference).min(1).max(4),
    }),
    z.object({ status: z.literal("skipped") }),
    z.object({
      status: z.literal("unavailable"),
      reason: browserScreenshotGap,
    }),
  ]),
});
export type BrowserPageSnapshot = z.infer<typeof browserPageSnapshot>;

export const browserBridgeFailureCode = z.enum([
  "cancelled",
  "deadline_exceeded",
  "invalid_command",
  "disallowed_url",
  "browser_unavailable",
  "browser_permission_denied",
  /** Chrome refuses JavaScript from Apple Events (View > Developer). */
  "javascript_disabled",
  /** The page's DOM could not be read (navigation in flight, crashed tab). */
  "page_unreadable",
  /** A required screenshot could not be taken; `screenshotGap` says why. */
  "screenshot_unavailable",
  "upload_failed",
  // The server's version gate refused this Mac build (HTTP 426).
  "client_update_required",
  "execution_failed",
]);
export const browserBridgeCommandOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    snapshot: browserPageSnapshot.nullable(),
    observation: browserObservation,
  }),
  z.object({
    status: z.literal("failed"),
    code: browserBridgeFailureCode,
    message: z.string().max(2_000),
    retryable: z.boolean(),
    screenshotGap: browserScreenshotGap.nullable(),
    observation: browserObservation,
  }),
]);
export const browserBridgeResult = z.object({
  protocolVersion: bridgeProtocol,
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
  /** The DOM trimming rules the Mac applies before it sends a snapshot. */
  snapshotVersion: z.number().int().positive(),
  screenshot: z.boolean(),
});
export const browserBridgeClientMessage = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("hello"),
    deviceID: z.uuid(),
    browser: browserChoice,
    capabilities: browserBridgeCapabilities,
  }),
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("result"),
    result: browserBridgeResult,
  }),
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("pong"),
    timestamp: z.iso.datetime(),
  }),
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("run_completed_ack"),
    runID: z.uuid(),
  }),
]);
export const browserBridgeRunCompletion = z.object({
  runID: z.uuid(),
  /** Only `completed` permits the account-owned window to be minimized. */
  terminalStatus: z.enum([
    "completed",
    "needs_review",
    "failed",
    "dispatch_failed",
  ]),
  outcome: runTargetOutcome.nullish(),
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  findingCount: z.number().int().nonnegative(),
  /**
   * The notification, written by the server in the unit the run worked in.
   * Absent only on completions a bridge stored before the server wrote one.
   */
  notice: z.object({ title: z.string(), body: z.string() }).optional(),
});
export type BrowserBridgeRunCompletion = z.infer<
  typeof browserBridgeRunCompletion
>;
export const browserBridgeServerMessage = z.discriminatedUnion("type", [
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("command"),
    command: browserBridgeRequest,
  }),
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("acknowledge"),
    commandID: z.uuid(),
  }),
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("cancel"),
    commandID: z.uuid(),
  }),
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("ping"),
    timestamp: z.iso.datetime(),
  }),
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("raise_auth_window"),
    runID: z.uuid(),
  }),
  z.object({
    protocolVersion: bridgeProtocol,
    type: z.literal("run_completed"),
    ...browserBridgeRunCompletion.shape,
  }),
]);

const agentEventBase = z.object({
  version: z.literal(1),
  runId: z.uuid(),
  purpose: agentImportRunPurpose.optional(),
  eventId: z.string().trim().min(1).max(256),
});
const agentEventId = z.string().trim().min(1).max(256);
export const purchaseAgentEvent = z.discriminatedUnion("type", [
  agentEventBase.extend({ type: z.literal("start_or_resume") }),
  agentEventBase.extend({
    type: z.literal("browser_connected"),
    connectionId: agentEventId.optional(),
  }),
  agentEventBase.extend({
    type: z.literal("browser_result"),
    commandId: agentEventId,
  }),
  agentEventBase.extend({
    type: z.literal("retry"),
    retryOf: agentEventId.optional(),
  }),
]);
export type PurchaseAgentEvent = z.infer<typeof purchaseAgentEvent>;

export const runScope = z.object({
  runId: runEntityId,
  shortcode: runShortcode,
  agentId: z.string().trim().min(1),
  trigger: runTrigger,
  purpose: runPurpose,
  status: runStatus,
  vendorAccountId: z.uuid().nullable(),
  vendorLabel: z.string().trim().min(1).max(500).nullable(),
  allowedHosts: z.array(z.string().trim().min(1).max(253)).max(20),
  navigationHints: z.unknown(),
  coordinatorModel: z.string().trim().min(1).max(200),
  skillRevision: z.string().trim().min(1).max(200),
  runtimeRevision: z.string().trim().min(1).max(200),
  dispatchEventId: z.string().uuid().nullable(),
  dispatchAttempts: z.number().int().nonnegative(),
  dispatchError: z.string().nullable(),
  coordinatorStartedAt: z.iso.datetime().nullable(),
});
export type RunScope = z.infer<typeof runScope>;

export const importWriterInput = z.object({
  targetPurchaseId: z.uuid().nullable().optional(),
  defaultTrade: tradeSchema.optional(),
  defaultProjectId: z.uuid().optional(),
  runId: z.uuid(),
  ledgerPartyId: z.uuid(),
  vendorId: z.uuid(),
  vendorAccountId: z.uuid().nullable(),
  source: importSourceIdentity,
  extraction: importExtractionOutcome,
  primaryDocumentImageId: z.uuid().nullable(),
  screenshotImageId: z.uuid().nullable(),
  productResolutions: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("existing"),
          lineIndex: z.number().int().nonnegative(),
          productId: z.uuid(),
        }),
        z.object({
          kind: z.literal("new"),
          lineIndex: z.number().int().nonnegative(),
        }),
        z.object({
          kind: z.literal("unresolved"),
          lineIndex: z.number().int().nonnegative(),
          reason: z.string().trim().min(1).max(1_000),
        }),
        z.object({
          kind: z.literal("expense_only"),
          lineIndex: z.number().int().nonnegative(),
        }),
      ]),
    )
    .optional(),
});
export type ImportWriterInput = z.infer<typeof importWriterInput>;

export const importWriterOutput = z.object({
  outcome: z.enum(["created", "updated", "replayed", "conflict"]),
  purchaseId: z.uuid().nullable(),
  findingIds: z.array(z.uuid()),
  outputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ImportWriterOutput = z.infer<typeof importWriterOutput>;

const preparedImportOrderInput = z
  .object({
    targetPurchaseId: purchaseShortcode.nullable().optional(),
    stableOrderId: stableImportItemId,
    itemOperationId: importItemOperationId,
    source: importSourceIdentity,
    evidenceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    extractionRevision: z.string().trim().min(1).max(200),
    extraction: importExtractionOutcome,
    lineIds: z.array(stableImportItemId).max(500),
    primaryDocumentImageId: imageShortcode.nullable().default(null),
    screenshotImageId: imageShortcode.nullable().default(null),
  })
  .superRefine((value, context) => {
    const expected = value.extraction.candidate?.lines.length ?? 0;
    if (value.lineIds.length !== expected) {
      context.addIssue({
        code: "custom",
        path: ["lineIds"],
        message: "lineIds must contain one stable id per extracted line",
      });
    }
    if (new Set(value.lineIds).size !== value.lineIds.length) {
      context.addIssue({
        code: "custom",
        path: ["lineIds"],
        message: "lineIds must be unique within an order",
      });
    }
  });

export const preparePurchaseImportInput = z
  .object({
    _runExecution: purchaseImportRunExecution,
    orders: z.array(preparedImportOrderInput).min(1).max(50),
  })
  .superRefine((value, context) => {
    const itemIds = value.orders.map((order) => order.itemOperationId);
    if (new Set(itemIds).size !== itemIds.length) {
      context.addIssue({
        code: "custom",
        path: ["orders"],
        message: "itemOperationId must be unique within a preparation",
      });
    }
    const executionIds = value._runExecution.itemOperationIds;
    if (
      executionIds &&
      (executionIds.length !== itemIds.length ||
        executionIds.some((id, index) => id !== itemIds[index]))
    ) {
      context.addIssue({
        code: "custom",
        path: ["_runExecution", "itemOperationIds"],
        message: "itemOperationIds must match orders in order",
      });
    }
  });
export type PreparePurchaseImportInput = z.infer<
  typeof preparePurchaseImportInput
>;

export const preparedProductCandidate = z.object({
  productId: productShortcode,
  name: z.string().trim().min(1).max(500),
  manufacturer: z.string().max(300),
  model: z.string().max(300).nullable(),
  exactIdentifierMatch: z.boolean(),
  /** Why a non-exact candidate ranks (e.g. a shared model/style number). */
  matchReason: z.string().max(300).optional(),
});

export const preparePurchaseImportOut = z.object({
  runId: runShortcode,
  operationId: importOperationId,
  status: z.literal("running"),
  orders: z.array(
    z.object({
      targetPurchaseId: purchaseShortcode.nullable().optional(),
      stableOrderId: stableImportItemId,
      itemOperationId: importItemOperationId,
      source: importSourceIdentity,
      orderId: z.string().nullable(),
      targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      lines: z.array(
        z.object({
          stableLineId: stableImportItemId,
          title: z.string(),
          amount: money,
          identifiers: z.record(z.string(), z.string()),
          candidates: z.array(preparedProductCandidate).max(20),
          requiresProductResolution: z.boolean(),
        }),
      ),
    }),
  ),
});

export const preparedProductResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), productId: productShortcode }),
  z.object({ kind: z.literal("new") }),
  z.object({
    kind: z.literal("unresolved"),
    reason: z.string().trim().min(1).max(1_000),
  }),
  /**
   * Household spending that is not a stocked item: prepared food, tickets,
   * rides, memberships, subscriptions, digital access, donations, services.
   * The line books an expense with no Product and nothing to review.
   */
  z.object({ kind: z.literal("expense_only") }),
]);

export const commitPurchaseImportInput = z.object({
  _runExecution: purchaseImportRunExecution,
  prepareOperationId: importOperationId,
  defaultTrade: tradeSchema.optional(),
  defaultProjectId: projectShortcode.optional(),
  resolutions: z
    .array(
      z.object({
        stableOrderId: stableImportItemId,
        stableLineId: stableImportItemId,
        resolution: preparedProductResolution,
      }),
    )
    .max(25_000),
});
export type CommitPurchaseImportInput = z.infer<
  typeof commitPurchaseImportInput
>;

export const commitPurchaseImportOut = z.object({
  runId: runShortcode,
  operationId: importOperationId,
  status: runStatus,
  items: z.array(
    z.object({
      stableOrderId: stableImportItemId,
      outcome: importWriterOutput.shape.outcome,
      purchaseId: purchaseShortcode.nullable(),
      findingCount: z.number().int().nonnegative(),
    }),
  ),
});

/** Read-only replay comparison for an immutable prepared validation batch. */
export const validatePurchaseImportInput = z.object({
  _runExecution: purchaseImportRunExecution,
  prepareOperationId: importOperationId,
  resolutions: commitPurchaseImportInput.shape.resolutions,
});
export type ValidatePurchaseImportInput = z.infer<
  typeof validatePurchaseImportInput
>;

export const validatePurchaseImportOut = z.object({
  runId: runShortcode,
  operationId: importOperationId,
  status: z.enum(["completed", "needs_review"]),
  targets: z.array(
    z.object({
      stableOrderId: stableImportItemId,
      outcome: z.enum(["replayed", "raw_evidence_drift", "semantic_drift"]),
      diff: z.json().nullable(),
    }),
  ),
});

/**
 * One line of the evidence plan as validation compares it. `productId` is a
 * Product shortcode, `new`/`unresolved` (a resolution with no Product yet),
 * or null for a non-principal or expense-only line.
 */
export const validationPlanLine = z.object({
  title: z.string(),
  amount: z.number(),
  lineKind: expenseLineKindSchema,
  quantity: z.number().nullable(),
  productId: z.string().nullable(),
});
export type ValidationPlanLine = z.infer<typeof validationPlanLine>;

export const validationExpectedPlan = z.object({
  orderId: z.string().nullable(),
  currency: z.string().nullable(),
  statedTotal: z.number().nullable(),
  lines: z.array(validationPlanLine),
  writeBlockReason: z.string().nullable(),
});
export type ValidationExpectedPlan = z.infer<typeof validationExpectedPlan>;

const sha256Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

/** A selectable, field-level change from the live Purchase toward the plan. */
export const validationCorrection = z.object({
  /** Stable across recomputation while the compared live values are unchanged. */
  id: z.string().min(1).max(200),
  kind: z.enum([
    "purchase_stated_total",
    "expense_field",
    "expense_add",
    "expense_remove",
  ]),
  target: z.object({
    kind: z.enum(["purchase", "expense"]),
    code: z.union([purchaseShortcode, expenseShortcode]),
  }),
  field: z.enum([
    "statedTotal",
    "title",
    "amount",
    "quantity",
    "lineKind",
    "productId",
    "line",
  ]),
  before: z.json(),
  after: z.json(),
  /** Hash of the live values this correction was computed from. */
  fingerprint: sha256Fingerprint,
});
export type ValidationCorrection = z.infer<typeof validationCorrection>;

/** A visible, unselectable difference validation will not change on its own. */
export const validationNote = z.object({
  id: z.string().min(1).max(200),
  target: validationCorrection.shape.target,
  field: z.string().min(1),
  before: z.json(),
  after: z.json(),
  message: z.string().min(1),
});
export type ValidationNote = z.infer<typeof validationNote>;

/** The versioned `RunTarget.diff` a purchase-validation target stores. */
export const validationDiff = z.object({
  version: z.literal(2),
  expected: validationExpectedPlan,
  actual: z.object({
    orderId: z.string().nullable(),
    currency: z.string(),
    statedTotal: z.number().nullable(),
    lines: z.array(validationPlanLine),
  }),
  corrections: z.array(validationCorrection),
  notes: z.array(validationNote),
  /** Evidence bytes changed since the target was frozen; kept for the outcome after a correction. */
  rawEvidenceDrift: z.boolean(),
});
export type ValidationDiff = z.infer<typeof validationDiff>;

/**
 * A person applies a reviewed subset of a validation diff. Never an agent
 * tool: it is absent from the MCP catalog and the agent's capability matrix.
 */
export const applyValidationCorrectionsInput = z.object({
  runId: runShortcode,
  purchaseId: purchaseShortcode,
  operationId: importOperationId,
  correctionIds: z.array(z.string().min(1).max(200)).min(1).max(500),
});
export type ApplyValidationCorrectionsInput = z.infer<
  typeof applyValidationCorrectionsInput
>;

export const applyValidationCorrectionsOut = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("applied"),
    runId: runShortcode,
    purchaseId: purchaseShortcode,
    operationId: importOperationId,
    applied: z.array(z.string()),
    outcome: z.enum(["replayed", "raw_evidence_drift", "semantic_drift"]),
    remainingCorrections: z.number().int().nonnegative(),
  }),
  /** Nothing was written: raw diagnostics name each selection that no longer holds. */
  z.object({
    status: z.literal("stale"),
    runId: runShortcode,
    purchaseId: purchaseShortcode,
    stale: z.array(
      z.object({
        correctionId: z.string().nullable(),
        reason: z.string().min(1),
      }),
    ),
  }),
]);
export type ApplyValidationCorrectionsOut = z.infer<
  typeof applyValidationCorrectionsOut
>;

/** Bounded Product enrichment write. Price is deliberately absent. */
export const commitProductEnrichmentInput = z.object({
  _runExecution: purchaseImportRunExecution,
  productId: productShortcode,
  targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z
    .object({
      manufacturer: z.string().trim().min(1).max(300).optional(),
      categoryId: productCategoryShortcode.optional(),
      model: z.string().trim().min(1).max(300).optional(),
      identifiers: z
        .array(
          z.object({
            evidenceId: z.uuid(),
            source: externalIdSource,
            kind: externalIdKind,
            externalId: z.string().trim().min(1).max(500),
            url: z.url().nullable().optional(),
          }),
        )
        .max(20)
        .optional(),
      image: z
        .object({
          evidenceId: z.uuid(),
          url: z.url(),
          naturalWidth: z.number().int().positive(),
          naturalHeight: z.number().int().positive(),
        })
        .optional(),
    })
    .refine(
      (value) => Object.keys(value).length > 0,
      "at least one change is required",
    ),
});
export type CommitProductEnrichmentInput = z.infer<
  typeof commitProductEnrichmentInput
>;

export const commitProductEnrichmentOut = z.object({
  runId: runShortcode,
  operationId: importOperationId,
  productId: productShortcode,
  status: z.enum(["running", "needs_review"]),
  changedFields: z.array(
    z.enum(["manufacturer", "categoryId", "model", "identifiers", "image"]),
  ),
  /**
   * Proven identifiers another Product already owns. They are never
   * reassigned; the pair is proposed in the Product match queue instead.
   */
  skippedIdentifiers: z
    .array(
      z.object({
        source: externalIdSource,
        kind: externalIdKind,
        externalId: z.string(),
        ownerProductId: productShortcode,
      }),
    )
    .default([]),
});

/**
 * Close one enrichment target without a write: no exact source proves the
 * variant, or the Product is retired, bundle-only, or ambiguous. The reason
 * stays on the target for the member, and the run moves to its next Product.
 */
export const skipProductEnrichmentInput = z.object({
  _runExecution: purchaseImportRunExecution,
  productId: productShortcode,
  reason: z.string().trim().min(1).max(500),
});
export type SkipProductEnrichmentInput = z.infer<
  typeof skipProductEnrichmentInput
>;
export const skipProductEnrichmentOut = z.object({
  runId: runShortcode,
  productId: productShortcode,
  state: z.literal("skipped"),
});

export const overwriteProductEnrichmentInput = z.object({
  _runExecution: purchaseImportRunExecution,
  productId: productShortcode,
  targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  change: z.discriminatedUnion("field", [
    z.object({
      field: z.literal("manufacturer"),
      value: z.string().trim().min(1).max(300).nullable(),
    }),
    z.object({
      field: z.literal("categoryId"),
      value: productCategoryShortcode.nullable(),
    }),
    z.object({
      field: z.literal("model"),
      value: z.string().trim().min(1).max(300).nullable(),
    }),
  ]),
});
export type OverwriteProductEnrichmentInput = z.infer<
  typeof overwriteProductEnrichmentInput
>;

export const overwriteProductEnrichmentOut = z.object({
  runId: runShortcode,
  productId: productShortcode,
  changedField: z.enum(["manufacturer", "categoryId", "model"]),
});

export const importOperationStatusInput = z.object({
  _runExecution: purchaseImportRunExecution,
});
export type ImportOperationStatusInput = z.infer<
  typeof importOperationStatusInput
>;

export const importOperationStatusOut = z.object({
  runId: runShortcode,
  operationId: importOperationId,
  kind: z.string(),
  state: z.enum(["started", "paused_approval", "completed", "failed"]),
  result: z.json().nullable(),
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
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
/** A card charge still waiting on a person-confirmed photo of its receipt. */
export const receiptHunt = z.object({
  id: z.uuid(),
  transactionDate: z.iso.date(),
  merchant: z.string().nullable(),
  amountInCents: z.number().int().nonnegative(),
});
export const listReceiptHuntsOut = z.object({ items: z.array(receiptHunt) });

export const importAuditFinding = z.object({
  kind: runFindingKind,
  targetPurchaseId: z.uuid(),
  summary: z.string().trim().min(1).max(1_000),
  probability: z.number().finite().min(0).max(1),
  proposedFix: proposedImportFix.nullable(),
});

// Model-output schemas carry no array bounds: Anthropic structured outputs
// reject `maxItems`/`minItems` outright. The writer re-parses lines against
// the bounded `extractedOrderCandidate` before anything is stored.
export const importAuditOutput = z.object({
  findings: z.array(importAuditFinding),
});
export type ImportAuditOutput = z.infer<typeof importAuditOutput>;

// Both OpenAI and Anthropic accept this required-field wire shape. The
// application validates the decoded fix against the domain union afterward;
// that union emits `oneOf`, which OpenAI's structured output rejects.
export const importAuditModelOutput = z.object({
  findings: z.array(
    z.object({
      kind: runFindingKind,
      targetPurchaseId: z.string(),
      summary: z.string(),
      probability: z.number(),
      proposedFixJson: z.string().nullable(),
    }),
  ),
});
export type ImportAuditModelOutput = z.infer<typeof importAuditModelOutput>;

export function normalizeImportAuditModelOutput(
  output: ImportAuditModelOutput,
): ImportAuditOutput {
  return importAuditOutput.parse({
    findings: output.findings.map(({ proposedFixJson, ...finding }) => {
      const proposedFix =
        proposedFixJson === null
          ? null
          : proposedImportFix.parse(JSON.parse(proposedFixJson));
      if (
        proposedFix &&
        !["relink_product", "replace_aggregate_line"].includes(proposedFix.kind)
      )
        throw new Error(`Audit cannot propose ${proposedFix.kind}`);
      return { ...finding, proposedFix };
    }),
  });
}
