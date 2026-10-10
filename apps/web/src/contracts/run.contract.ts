import { aiRunUsageInput, aiRunUsageOut } from "@cubby/schemas/ai";
import {
  executionAuthorizationApprovalInput,
  executionAuthorizationRef,
  executionAuthorizationRequestedScope,
} from "@cubby/schemas/execution-authorization";
import {
  runShortcode,
  imageShortcode,
  productShortcode,
  purchaseShortcode,
} from "@cubby/schemas/identifiers";
import { mailboxDiscoveryStartOutput } from "@cubby/schemas/mailbox-research";
import { runTargetDeviceWorkState } from "@cubby/schemas/photo-import-run";
import {
  proposedImportFix,
  confirmMerchantVendorRuleInput,
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  preparePurchaseImportOut,
} from "@cubby/schemas/purchase-import";
import { runHistoryOut, runOut } from "@cubby/schemas/run";
import { runRestartInput } from "@cubby/schemas/run-fields";
import {
  runControlAction,
  runPurpose,
  runStatus,
  runTargetEntityKind,
} from "@cubby/schemas/run-fields";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

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
  vendor: z.string().nullable(),
  vendorAccount: z.string().nullable(),
  input: runRestartInput.nullable(),
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
const runDetail = z
  .object({
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
        proposedFix: proposedImportFix.nullable(),
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
        prepareOperationId: commitPurchaseImportInput.shape.prepareOperationId,
        itemOperationId: z.string().min(1),
        sourceKind: z.string().min(1),
        externalKey: z.string().nullable(),
        preparedAt: z.iso.datetime(),
        lineCount: z.number().int().nonnegative(),
        committed: z.boolean(),
        lines: preparePurchaseImportOut.shape.orders.element.shape.lines,
      }),
    ),
    targets: z.array(
      z.object({
        id: z.string().min(1),
        targetType: runTargetEntityKind,
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
  })
  .extend(runOut.pick({ parentRunId: true, cause: true, attempt: true }).shape);
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

const runControlInput = z.object({
  runId: runShortcode,
  action: runControlAction,
  operationId: z.string().min(1).optional(),
  approvalId: z.string().min(1).optional(),
});
const runControlOutput = z.object({
  run: runDetail,
  successor: z
    .object({
      publicId: runShortcode,
      status: z.string().min(1),
      created: z.boolean(),
    })
    .nullable(),
});

export const runContract = defineContract("run", {
  executionMailboxes: query({
    native: "Select a connected owned mailbox for an execution approval",
    mcp: { omit: "human_approval" },
    input: z.strictObject({}),
    output: z.object({
      mailboxes: z.array(
        executionAuthorizationRequestedScope.pick({ mailboxId: true }),
      ),
    }),
    cache: { tags: [] },
  }),
  approveExecution: mutation({
    native:
      "Approve exact mailbox discovery scope, limits, metered budget and expiry",
    mcp: { omit: "human_approval" },
    input: executionAuthorizationApprovalInput,
    output: executionAuthorizationRef,
    invalidates: ["runOnly"],
  }),
  discoverMail: mutation({
    native:
      "Start discovery for one owned mailbox under its current execution approvals",
    mcp: { omit: "human_approval" },
    input: executionAuthorizationRequestedScope.pick({ mailboxId: true }),
    output: mailboxDiscoveryStartOutput,
    invalidates: ["runOnly"],
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
      findings: runDetail.shape.findings,
      targetsTotal: z.number().int(),
      targetsCompleted: z.number().int(),
      /**
       * Each target's outcome: what the run worked and why it ended where it
       * did (a skip keeps its reason in `warning`).
       */
      targets: z.array(
        runDetail.shape.targets.element.pick({
          targetType: true,
          targetShortcode: true,
          targetName: true,
          state: true,
          outcome: true,
          warning: true,
          completedAt: true,
        }),
      ),
      progress: z.array(
        z.object({
          phase: z.string(),
          detail: z.string().nullable(),
          createdAt: z.iso.datetime(),
        }),
      ),
      operations: z.array(
        runDetail.shape.operations.element.omit({ operationId: true }),
      ),
    }),
    cache: { tags: [] },
  }),
  history: query({
    mcp: { omit: "client_view" },
    native: "Native Product enrichment history",
    input: z
      .object({
        purchaseId: purchaseShortcode.optional(),
        productId: productShortcode.optional(),
      })
      .refine((input) => !(input.purchaseId && input.productId), {
        message: "Choose either a Purchase or a Product",
      }),
    output: runHistoryOut,
    cache: { tags: [["run"]] },
  }),
  work: query({
    mcp: { omit: "client_view" },
    native: "Show one Run's targets, findings, operations and prepared orders",
    input: z.object({ runId: runShortcode }),
    output: runDetail,
    cache: { tags: [["run"]] },
  }),
  commitPrepared: mutation({
    mcp: { omit: "human_approval" },
    native:
      "Approve a prepared import batch after the per-line Product and trade decisions",
    input: commitPurchaseImportInput.omit({ _runExecution: true }).extend({
      runId: runShortcode,
      operationId:
        commitPurchaseImportInput.shape._runExecution.shape.operationId,
    }),
    output: commitPurchaseImportOut,
    invalidates: ["runOnly", "purchase", "product"],
  }),
  control: mutation({
    mcp: { omit: "human_approval" },
    native: "Approve, reject, stop or retry a Run from its detail sections",
    input: runControlInput,
    output: runControlOutput,
    invalidates: ["runOnly"],
  }),
  lifecycle: mutation({
    input: runControlInput
      .omit({ action: true, operationId: true, approvalId: true })
      .extend({
        controlAction: runControlAction.extract(["cancel", "retry", "restart"]),
      }),
    output: runControlOutput.extend({
      run: runDetail.pick({
        publicId: true,
        status: true,
        failureCode: true,
        endedAt: true,
      }),
    }),
    invalidates: ["runOnly"],
  }),
  logs: query({
    mcp: { omit: "operator_maintenance" },
    input: z.object({ runId: runShortcode }),
    output: z.object({
      entries: z.array(runLogEntry),
      truncated: z.boolean(),
    }),
    cache: { tags: [["run"]] },
  }),
  /** The member's purchase-import agent OAuth grant. */
  agentConnection: query({
    mcp: { omit: "auth_connection" },
    input: z.undefined(),
    output: agentConnection,
    cache: { tags: [["run"]] },
  }),
  /** Revokes the grant and pauses the runs it authorized. */
  disconnectAgent: mutation({
    mcp: { omit: "auth_connection" },
    input: z.undefined(),
    output: agentConnection,
    invalidates: ["runOnly"],
  }),
  merchantRules: query({
    mcp: { omit: "client_view" },
    input: z.undefined(),
    output: merchantRules,
    cache: { tags: [] },
  }),
  confirmMerchantRule: mutation({
    mcp: { omit: "agent_twin", twin: "purchaseImport.confirmMerchantVendor" },
    input: confirmMerchantVendorRuleInput,
    output: merchantRules,
  }),
  aiUsage: query({
    mcp: { omit: "client_view" },
    native: "Show live AI spend alongside native run timing",
    input: aiRunUsageInput,
    output: aiRunUsageOut,
    cache: { tags: [["ai", "usage"]] },
  }),
  /**
   * Idempotent device-side status for one photo-run image target. The
   * uploader reports queued/running/failed/completed as it works through a
   * run's photos; repeating the same {run, image, state} is a no-op.
   */
  reportDeviceWork: mutation({
    mcp: { omit: "device_protocol" },
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
