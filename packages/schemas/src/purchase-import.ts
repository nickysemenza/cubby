import { tradeSchema } from "./task-fields";
import { z } from "zod";
import { agentImportRunPurpose } from "./import-run-agent";
import { plainDate } from "./base-entity";

import { mailEvent } from "./mailbox-research";
import { money } from "./money";
import {
  runEvidenceKind,
  runPurpose,
  runStatus,
  runTrigger,
} from "./run-fields";
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
export const importSourceKind = z.enum([
  "browser_order",
  "mail_message",
  "mail_attachment",
  "receipt_photo",
  "vendor_export",
]);
export { runPurpose, runStatus, runTrigger } from "./run-fields";
export type RunTrigger = z.infer<typeof runTrigger>;
export type RunPurpose = z.infer<typeof runPurpose>;

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
export function countRunTargets(states: readonly RunTargetState[]) {
  const counts = { total: 0, completed: 0, skipped: 0, blocked: 0, pending: 0 };
  for (const state of states) {
    counts.total += 1;
    counts[RUN_TARGET_BUCKET[state]] += 1;
  }
  return counts;
}

export { runEvidenceKind };
export type { RunEvidenceKind } from "./run-fields";

export { runShortcode };
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
export const purchaseImportRunExecution = z
  .object({
    // The private run id: it is what the delegation token and agent instance
    // carry, so the public code can change without touching agent state.
    runId: z.uuid().optional(),
    // A member names the Run its own preparation returned. A member's
    // preparation without either opens a new import Run.
    run: runShortcode.optional(),
    operationId: importOperationId,
    itemOperationIds: z.array(importItemOperationId).min(1).max(50).optional(),
  })
  .refine((value) => !(value.runId && value.run), {
    message: "Name the import Run once: runId (agent) or run (member)",
    path: ["run"],
  });
export type PurchaseImportRunExecution = z.infer<
  typeof purchaseImportRunExecution
>;

export const importSourceIdentity = z.object({
  kind: importSourceKind,
  externalKey: z.string().trim().min(1).max(512),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
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

const extractedOrderDate = z
  .union([plainDate.pipe(z.iso.date()), z.iso.datetime({ offset: true })])
  .nullable()
  .describe(
    "Source-printed order date as YYYY-MM-DD, or an explicit ISO timestamp with timezone. Preserve a printed calendar day without inventing a time or timezone. Null when absent; email receipt time is not an order date.",
  );

export const extractedOrderCandidate = z.object({
  orderId: z.string().trim().min(1).max(300).nullable(),
  orderedAt: extractedOrderDate,
  merchant: z.string().trim().min(1).max(300).nullable(),
  currency: z.string().trim().length(3).nullable(),
  printedGrandTotal: money.nullable(),
  lines: z.array(extractedPurchaseLine).max(500),
  payments: z.array(extractedPaymentEvidence).max(100),
  allShipmentsDelivered: z.boolean().nullable(),
  sourceEvent: mailEvent
    .optional()
    .describe(
      "For an Email source: the lifecycle event it records about the order (default confirmation).",
    ),
});
export type ExtractedOrderCandidate = z.infer<typeof extractedOrderCandidate>;

const importExtractionReviewReason = z.enum([
  "missing_currency",
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

/** Accepted ordered-item identity remains independent of later catalog or ledger edits. */
export const acceptedSourceOrder = z.object({
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  extraction: importExtractionOutcome,
});
export type AcceptedSourceOrder = z.infer<typeof acceptedSourceOrder>;

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
  orderedAt: extractedOrderDate,
  merchant: z.string().trim().min(1).max(300).nullable(),
  currency: z.string().trim().length(3).nullable(),
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

export const orderMailClassification = z.object({
  event: z.enum(["placed", "shipped", "delivered", "refunded", "other"]),
  orderId: z.string().trim().min(1).max(300).nullable(),
  amount: money.nullable(),
  currency: z.string().trim().length(3).nullable(),
  occurredAt: z.iso.datetime().nullable(),
});
export const orderMailMessageClassification = z.object({
  events: z.array(orderMailClassification).max(50),
});
export type OrderMailMessageClassification = z.infer<
  typeof orderMailMessageClassification
>;

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
  orderLocator: z.string().trim().min(1).max(128).optional(),
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
    vendorId: vendorShortcode
      .optional()
      .describe(
        "The existing Vendor this order was bought from. Omit only when the import Run already names the Vendor.",
      ),
    vendor: z
      .object({ name: z.string().trim().min(1).max(200) })
      .optional()
      .describe(
        "A Vendor named exactly as the source names the seller, when no existing Vendor matches; Cubby reuses an exact-name Vendor.",
      ),
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
    if (value.vendorId && value.vendor)
      context.addIssue({
        code: "custom",
        path: ["vendorId"],
        message: "Name the order's Vendor once: vendorId or vendor",
      });
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
  z
    .object({ kind: z.literal("existing"), productId: productShortcode })
    .describe(
      "Reuse an existing Product whose exact item and variant match the source without contradicting its recorded facts. productId is the public Product shortcode returned by Cubby search.",
    ),
  z
    .object({ kind: z.literal("new") })
    .describe(
      "Create a Product from supported order-line facts after checking existing matches. Missing catalog identity stays unknown and continues through Product research.",
    ),
  z
    .object({
      kind: z.literal("unresolved"),
      reason: z.string().trim().min(1).max(1_000),
    })
    .describe(
      "Retain a specific unresolved Product identity or variant ambiguity for review while preserving supported spending.",
    ),
  z
    .object({ kind: z.literal("expense_only") })
    .describe(
      "Spending with no tracked Product: prepared restaurant food, tickets, rides, donations or labor. Seeds, plants, ingredients, groceries, tools, supplies, tracked software and subscriptions delivering goods require a Product decision.",
    ),
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

export const importOperationStatusInput = z.object({
  _runExecution: purchaseImportRunExecution,
});
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
