import { aiRunUsageInput, aiRunUsageOut } from "@cubby/schemas/ai";
import {
  runShortcode,
  imageShortcode,
  productShortcode,
  purchaseShortcode,
} from "@cubby/schemas/identifiers";
import { runTargetDeviceWorkState } from "@cubby/schemas/photo-import-run";
import { confirmMerchantVendorRuleInput } from "@cubby/schemas/purchase-import";
import {
  runBrowserListInput,
  runListResponse,
  runOut,
} from "@cubby/schemas/run";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

const runSummary = z.object({
  publicId: runShortcode,
  purpose: runPurpose,
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
export type RunSummary = z.infer<typeof runSummary>;

const runProgress = z.object({
  eventId: z.string().min(1),
  phase: z.string().min(1),
  currentItem: z.string().nullable(),
  awaitingApproval: z.boolean(),
  detail: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const runController = z.object({
  name: z.string().nullable(),
  ledgerParty: z
    .object({ id: z.string().nullable(), name: z.string().nullable() })
    .nullable(),
});

/** The settings and targets "Start new run with same inputs" copies. */
const restartInputs = z.object({
  purpose: z.string(),
  trigger: z.literal("manual"),
  coordinatorModel: z.string(),
  vendorAccount: z.string().nullable(),
  notes: z.string().nullable(),
  skillRevision: z.string().nullable(),
  runtimeRevision: z.string().nullable(),
  targets: z.array(
    z.object({
      position: z.number().int().nullable(),
      image: z.string().nullable(),
      purchase: z.string().nullable(),
      product: z.string().nullable(),
      vendorAccount: z.string().nullable(),
      sourceKind: z.string().nullable(),
      sourceExternalKey: z.string().nullable(),
      targetFingerprint: z.string().nullable(),
    }),
  ),
});

/** The run work view. Private UUIDs and operation payloads never cross it. */
const runDetail = z.object({
  publicId: runShortcode,
  purpose: runPurpose,
  status: z.string().min(1),
  trigger: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  ordersSeen: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failureCode: z.string().nullable(),
  notes: z.string().nullable(),
  predecessorRunPublicId: runShortcode.nullable(),
  successorRunPublicId: runShortcode.nullable(),
  /** Null for runs that cannot be started again. */
  restartInputs: restartInputs.nullable(),
  coordinatorModel: z.string().nullable(),
  skillRevision: z.string().nullable(),
  runtimeRevision: z.string().nullable(),
  agentModelMs: z.number().nonnegative(),
  source: z.object({ kind: z.string(), vendorName: z.string().nullable() }),
  actor: runController,
  controllingMembers: z.array(runController),
  controlHistory: z.array(
    runController.extend({
      action: z.string().min(1),
      createdAt: z.iso.datetime(),
    }),
  ),
  vendorAccount: z.object({ id: z.string(), label: z.string() }).nullable(),
  affectedPurchases: z.array(
    z.object({
      shortcode: z.string().min(1),
      displayName: z.string().nullable(),
      orderId: z.string().nullable(),
    }),
  ),
  findings: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.string().min(1),
      summary: z.string().min(1),
      status: z.string().min(1),
      autoApplied: z.boolean(),
      probability: z.number().nullable(),
      createdAt: z.iso.datetime(),
      expiresAt: z.iso.datetime().nullable(),
    }),
  ),
  operations: z.array(
    z.object({
      operationId: z.string().min(1),
      kind: z.string().min(1),
      state: z.string().min(1),
      startedAt: z.iso.datetime(),
      completedAt: z.iso.datetime().nullable(),
      error: z.string().nullable(),
    }),
  ),
  preparedOrders: z.array(
    z.object({
      stableOrderId: z.string().min(1),
      itemOperationId: z.string().min(1),
      sourceKind: z.string().min(1),
      externalKey: z.string().nullable(),
      preparedAt: z.iso.datetime(),
      lineCount: z.number().int().nonnegative(),
    }),
  ),
  targets: z.array(
    z.object({
      id: z.string().min(1),
      targetType: z.enum(["purchase", "product", "image"]),
      targetShortcode: z.string().min(1).nullable(),
      targetName: z.string().nullable(),
      sourceId: z.string().nullable(),
      sourceLabel: z.string().nullable(),
      vendorAccountLabel: z.string().nullable(),
      state: z.string().min(1),
      fingerprint: z.string().nullable(),
      outcome: z.string().nullable(),
      warning: z.string().nullable(),
      diff: z.json().nullable(),
      completedAt: z.iso.datetime().nullable(),
    }),
  ),
  evidence: z.array(
    z.object({
      id: z.string().min(1),
      targetId: z.string().nullable(),
      sourceKind: z.string().min(1),
      filename: z.string().nullable(),
      mediaType: z.string().nullable(),
      checksum: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  dispatch: z.object({
    eventId: z.string().nullable(),
    state: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    error: z.string().nullable(),
    coordinatorStartedAt: z.iso.datetime().nullable(),
  }),
  progress: z.array(runProgress),
  latestProgress: runProgress.nullable(),
  approvals: z.array(
    z.object({
      id: z.string().min(1),
      operationId: z.string().min(1),
      operationKind: z.string().min(1),
      args: z.json(),
      state: z.string().min(1),
      grantedAt: z.iso.datetime().nullable(),
      consumedAt: z.iso.datetime().nullable(),
      invalidatedAt: z.iso.datetime().nullable(),
      rejectedAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type RunDetail = z.infer<typeof runDetail>;

const runLogEntry = z.object({
  id: z.string(),
  occurredAt: z.iso.datetime(),
  source: z.enum(["run", "server", "mac"]),
  level: z.enum(["debug", "info", "error"]),
  event: z.string(),
  state: z.string().nullable(),
  commandId: z.uuid().nullable(),
  operationId: z.string().nullable(),
  operationKind: z.string().nullable(),
  host: z.string().nullable(),
  browser: z.string().nullable(),
  attempt: z.number().int().nullable(),
  count: z.number().int().nullable(),
  outcome: z.string().nullable(),
  messageType: z.string().nullable(),
  errorType: z.string().nullable(),
  errorCode: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type RunLogEntry = z.infer<typeof runLogEntry>;

const agentConnection = z.object({
  authorized: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
});

const merchantRules = z.object({
  rules: z.array(
    z.object({
      merchant: z.string(),
      vendorId: z.string(),
      vendorName: z.string(),
    }),
  ),
  vendors: z.array(z.object({ shortcode: z.string(), name: z.string() })),
});

export const targetedImportPurpose = z.enum([
  "purchase_validation",
  "product_enrichment",
]);
export type TargetedImportPurpose = z.infer<typeof targetedImportPurpose>;

const targetedImportSource = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.string().min(1),
  fingerprint: z.string().nullable(),
  vendorAccountId: z.string().nullable(),
  vendorAccountLabel: z.string().nullable(),
  usable: z.boolean(),
  reason: z.string().nullable(),
  default: z.boolean(),
});
export type TargetedImportSource = z.infer<typeof targetedImportSource>;

const targetedProductCandidate = z.object({
  productId: z.string().min(1),
  productName: z.string().min(1),
  selected: z.boolean(),
  sourceId: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  vendorAccountId: z.string().nullable(),
  vendorAccountLabel: z.string().nullable(),
  needsAccountChoice: z.boolean(),
  accountChoices: z.array(
    z.object({ id: z.string().min(1), label: z.string().min(1) }),
  ),
  reason: z.string().nullable(),
});
export type TargetedProductCandidate = z.infer<typeof targetedProductCandidate>;

const targetedImportLaunch = z.object({
  purpose: targetedImportPurpose,
  purchase: z
    .object({
      id: z.string().min(1),
      label: z.string().min(1),
      canValidate: z.boolean(),
      reason: z.string().nullable(),
      sources: z.array(targetedImportSource),
      products: z.array(targetedProductCandidate),
    })
    .nullable(),
  products: z.array(targetedProductCandidate),
});
export type TargetedImportLaunch = z.infer<typeof targetedImportLaunch>;

/**
 * Targeted import launch. Entity targets use public shortcodes; an opaque
 * source-claim id is resolved again against the actor's own claims.
 */
const targetedImportStartInput = z.discriminatedUnion("purpose", [
  z.object({
    purpose: z.literal("purchase_validation"),
    purchaseId: purchaseShortcode,
    sourceId: z.string().min(1).nullable(),
  }),
  z.object({
    purpose: z.literal("product_enrichment"),
    targets: z
      .array(
        z.object({
          productId: productShortcode,
          sourceId: z.string().min(1).nullable(),
          vendorAccountId: z.string().min(1).nullable(),
        }),
      )
      .min(1),
  }),
]);
export type TargetedImportStartInput = z.input<typeof targetedImportStartInput>;

const targetedImportStartOutput = z.object({
  runs: z.array(
    z.object({
      created: z.boolean(),
      run: z
        .object({
          id: runShortcode,
          status: z.string().min(1),
          purpose: targetedImportPurpose,
          dispatchEventId: z.string().nullable(),
        })
        .nullable(),
      blockingRun: z
        .object({ id: runShortcode, status: z.string().min(1) })
        .nullable(),
    }),
  ),
});
export type TargetedImportStartOutput = z.infer<
  typeof targetedImportStartOutput
>;

/**
 * Run reads for the generic list and detail pages. A Run has no create/update
 * contract, so it sits outside the kernel list and detail rosters and reads
 * its own queries (a list override source, `route.detail: { query }`), like
 * image and cookbook.
 */
export const runContract = defineContract("run", {
  list: query({
    input: runBrowserListInput,
    output: runListResponse,
  }),
  detail: query({
    input: z.object({ shortcode: z.string() }),
    output: runOut.nullable(),
  }),
  workSnapshot: query({
    native: "Show durable live import progress in Apple apps",
    input: z.object({ runId: runShortcode }),
    output: z.object({
      runId: runShortcode,
      purpose: runPurpose,
      status: runStatus,
      startedAt: z.iso.datetime(),
      endedAt: z.iso.datetime().nullable(),
      coordinatorModel: z.string().nullable(),
      agentModelMs: z.number().nonnegative(),
      ordersSeen: z.number().int(),
      imported: z.number().int(),
      updated: z.number().int(),
      skipped: z.number().int(),
      targetsTotal: z.number().int(),
      targetsCompleted: z.number().int(),
      progress: z.array(
        z.object({
          phase: z.string(),
          detail: z.string().nullable(),
          createdAt: z.iso.datetime(),
        }),
      ),
      operations: z.array(
        z.object({
          kind: z.string(),
          state: z.string(),
          startedAt: z.iso.datetime(),
          completedAt: z.iso.datetime().nullable(),
          error: z.string().nullable(),
        }),
      ),
    }),
  }),
  history: query({
    input: z
      .object({
        purchaseId: purchaseShortcode.optional(),
        productId: productShortcode.optional(),
      })
      .refine((input) => !(input.purchaseId && input.productId), {
        message: "Choose either a Purchase or a Product",
      }),
    output: z.object({ runs: z.array(runSummary) }),
  }),
  work: query({
    input: z.object({ runId: runShortcode }),
    output: runDetail,
  }),
  control: mutation({
    input: z.object({
      runId: runShortcode,
      action: z.enum([
        "pause",
        "resume",
        "cancel",
        "approve",
        "reject",
        "retry",
        "restart",
        "escalate_sol",
        "retry_dispatch",
        "abort",
        "upload_evidence",
        "no_evidence_available",
      ]),
      operationId: z.string().min(1).optional(),
      approvalId: z.string().min(1).optional(),
    }),
    output: z.object({
      run: runDetail,
      successor: z
        .object({
          publicId: runShortcode,
          status: z.string().min(1),
          created: z.boolean(),
        })
        .nullable(),
    }),
  }),
  logs: query({
    input: z.object({ runId: runShortcode }),
    output: z.object({
      entries: z.array(runLogEntry),
      truncated: z.boolean(),
    }),
  }),
  targetedLaunch: query({
    input: z.object({
      purpose: targetedImportPurpose,
      targetId: z.string().min(1),
    }),
    output: targetedImportLaunch,
  }),
  startTargeted: mutation({
    // The HTTP document cannot name this union's members; browser-only.
    http: false,
    input: targetedImportStartInput,
    output: targetedImportStartOutput,
  }),
  /** The member's purchase-import agent OAuth grant. */
  agentConnection: query({ input: z.undefined(), output: agentConnection }),
  /** Revokes the grant and pauses the runs it authorized. */
  disconnectAgent: mutation({
    input: z.undefined(),
    output: agentConnection,
  }),
  merchantRules: query({ input: z.undefined(), output: merchantRules }),
  confirmMerchantRule: mutation({
    input: confirmMerchantVendorRuleInput,
    output: merchantRules,
  }),
  aiUsage: query({
    native: "Show live AI spend alongside native run timing",
    input: aiRunUsageInput,
    output: aiRunUsageOut,
  }),
  /**
   * Idempotent device-side status for one photo-run image target. The
   * uploader reports queued/running/failed/completed as it works through a
   * run's photos; repeating the same {run, image, state} is a no-op.
   */
  reportDeviceWork: mutation({
    native: "Report on-device photo processing progress for a run target",
    input: z.object({
      run: runShortcode,
      image: imageShortcode,
      state: runTargetDeviceWorkState,
      error: z.string().min(1).max(2000).optional(),
    }),
    output: z.object({ recorded: z.boolean() }),
  }),
});
