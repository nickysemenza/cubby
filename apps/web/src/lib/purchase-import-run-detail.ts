import { z } from "zod";

export const importRunPublicId = z
  .string()
  .regex(/^PIR-[A-Z0-9]{10}$/u, "Import run was not found");

const purchaseImportRunSummary = z.object({
  publicId: importRunPublicId,
  purpose: z
    .enum(["account_sync", "purchase_validation", "product_enrichment"])
    .optional(),
  vendorAccountLabel: z.string().nullable(),
  vendorName: z.string().nullable(),
  trigger: z.string(),
  status: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  ordersSeen: z.number().int(),
  imported: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  failureCode: z.string().nullable(),
  estimatedCost: z.number(),
});
export type PurchaseImportRunSummary = z.infer<typeof purchaseImportRunSummary>;

export const purchaseImportRunsResponse = z.object({
  runs: z.array(purchaseImportRunSummary),
});
export const purchaseImportRunsError = z.object({ error: z.string() });

export const purchaseImportAgentOAuthStatus = z.object({
  authorized: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
});

const importRunOperation = z.object({
  operationId: z.string().min(1),
  kind: z.string().min(1),
  state: z.string().min(1),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
});

const importRunPreparedOrder = z.object({
  stableOrderId: z.string().min(1),
  itemOperationId: z.string().min(1),
  sourceKind: z.string().min(1),
  externalKey: z.string().nullable(),
  preparedAt: z.iso.datetime(),
  lineCount: z.number().int().nonnegative(),
});

const importRunApproval = z.object({
  id: z.string().min(1),
  operationId: z.string().min(1),
  operationKind: z.string().min(1),
  args: z.unknown(),
  state: z.string().min(1),
  grantedAt: z.iso.datetime().nullable(),
  consumedAt: z.iso.datetime().nullable(),
  invalidatedAt: z.iso.datetime().nullable(),
  rejectedAt: z.iso.datetime().nullable(),
});

const importRunUsage = z.object({
  pricedSubtotal: z.number().nonnegative(),
  unpricedCount: z.number().int().nonnegative(),
  records: z.array(
    z.object({
      id: z.string().min(1),
      createdAt: z.iso.datetime(),
      feature: z.string().min(1),
      operation: z.string().min(1),
      provider: z.string().min(1),
      model: z.string().min(1),
      attempt: z.number().int().nullable(),
      inputTokens: z.number().int().nullable(),
      outputTokens: z.number().int().nullable(),
      cacheReadTokens: z.number().int().nullable(),
      cacheWriteTokens: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative(),
      status: z.string().min(1),
      gatewayLogId: z.string().nullable(),
      estimatedCost: z.number().nonnegative().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

const importRunProgress = z.object({
  eventId: z.string().min(1),
  phase: z.string().min(1),
  currentItem: z.string().nullable(),
  awaitingApproval: z.boolean(),
  detail: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const importRunController = z.object({
  name: z.string().nullable(),
  ledgerParty: z
    .object({ id: z.string().nullable(), name: z.string().nullable() })
    .nullable(),
});

const importRunPurchase = z.object({
  shortcode: z.string().min(1),
  displayName: z.string().nullable(),
  orderId: z.string().nullable(),
});

const importRunFinding = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string().min(1),
  status: z.string().min(1),
  autoApplied: z.boolean(),
  probability: z.number().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});

const importRunTarget = z.object({
  id: z.string().min(1),
  targetType: z.enum(["purchase", "product"]),
  targetShortcode: z.string().min(1).nullable(),
  targetName: z.string().nullable(),
  sourceId: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  vendorAccountLabel: z.string().nullable(),
  state: z.string().min(1),
  fingerprint: z.string().nullable(),
  outcome: z.string().nullable(),
  warning: z.string().nullable(),
  diff: z.unknown().nullable(),
  completedAt: z.iso.datetime().nullable(),
});

const importRunEvidence = z.object({
  id: z.string().min(1),
  targetId: z.string().nullable(),
  sourceKind: z.string().min(1),
  filename: z.string().nullable(),
  mediaType: z.string().nullable(),
  checksum: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const importRunDispatch = z.object({
  eventId: z.string().nullable(),
  state: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  coordinatorStartedAt: z.iso.datetime().nullable(),
});

/** The browser-facing detail contract. Private UUIDs never cross this boundary. */
const purchaseImportRunDetail = z.object({
  publicId: importRunPublicId,
  purpose: z
    .enum(["account_sync", "purchase_validation", "product_enrichment"])
    .optional(),
  status: z.string().min(1),
  trigger: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  ordersSeen: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failureCode: z.string().nullable(),
  predecessorRunPublicId: importRunPublicId.nullable(),
  successorRunPublicId: importRunPublicId.nullable().optional(),
  coordinatorModel: z.string().nullable(),
  skillRevision: z.string().nullable(),
  runtimeRevision: z.string().nullable(),
  source: z
    .object({ kind: z.string(), vendorName: z.string().nullable() })
    .nullable(),
  actor: z
    .object({
      name: z.string().nullable(),
      ledgerParty: z
        .object({ id: z.string().nullable(), name: z.string().nullable() })
        .nullable(),
    })
    .nullable(),
  controllingMembers: z.array(importRunController).default([]),
  controlHistory: z
    .array(
      importRunController.extend({
        action: z.string().min(1),
        createdAt: z.iso.datetime(),
      }),
    )
    .default([]),
  vendorAccount: z.object({ id: z.string(), label: z.string() }).nullable(),
  usage: importRunUsage.nullable().optional(),
  affectedPurchases: z.array(importRunPurchase).default([]),
  findings: z.array(importRunFinding).default([]),
  operations: z.array(importRunOperation),
  preparedOrders: z.array(importRunPreparedOrder),
  targets: z.array(importRunTarget).default([]),
  evidence: z.array(importRunEvidence).default([]),
  dispatch: importRunDispatch.nullable().optional(),
  progress: z.array(importRunProgress).default([]),
  latestProgress: importRunProgress.nullable(),
  approvals: z.array(importRunApproval),
});

export type PurchaseImportRunDetail = z.infer<typeof purchaseImportRunDetail>;

export const purchaseImportRunDetailResponse = z.object({
  run: purchaseImportRunDetail,
});

export const purchaseImportRunControlInput = z.object({
  action: z.enum([
    "pause",
    "resume",
    "cancel",
    "approve",
    "reject",
    "retry",
    "escalate_sol",
    "retry_dispatch",
    "abort",
    "upload_evidence",
    "no_evidence_available",
  ]),
  operationId: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
});

export const purchaseImportRunControlResponse = z.object({
  run: purchaseImportRunDetail,
  successor: z
    .object({
      publicId: importRunPublicId,
      status: z.string().min(1),
      created: z.boolean(),
    })
    .nullable()
    .optional(),
});

export const purchaseImportRunDetailError = z.object({ error: z.string() });
