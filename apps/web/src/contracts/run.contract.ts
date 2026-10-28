import { agentConversationSchema } from "@cubby/schemas/agent-conversation";
import { aiRunUsageInput, aiRunUsageOut } from "@cubby/schemas/ai";
import { mailReclassificationRead } from "@cubby/schemas/email-actions";
import {
  runShortcode,
  imageShortcode,
  productShortcode,
  purchaseShortcode,
} from "@cubby/schemas/identifiers";
import {
  mailImportStatus,
  paidOverBudgetUsd,
  setMailImportInput,
} from "@cubby/schemas/mail-import-settings";
import {
  mailboxDiscoveryStartOutput,
  mailboxDiscoveryProgressSummary,
  mailboxCoverageSummary,
  mailboxQueryListSummary,
  discoveryEmailAuditPage,
} from "@cubby/schemas/mailbox-research";
import { runTargetDeviceWorkState } from "@cubby/schemas/photo-import-run";
import {
  proposedImportFix,
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  preparePurchaseImportOut,
} from "@cubby/schemas/purchase-import";
import { runHistoryOut, runOut } from "@cubby/schemas/run";
import { runTargetOutcomeReceipt } from "@cubby/schemas/run-fields";
import { runRestartInput } from "@cubby/schemas/run-fields";
import {
  runControlAction,
  runPurpose,
  runRetirementReason,
  runStatus,
} from "@cubby/schemas/run-fields";
import { runStepErrors } from "@cubby/schemas/run-step";
import { runWorkProgress } from "@cubby/schemas/run-work-progress";
import { sweepEstimateOut, sweepStartInput } from "@cubby/schemas/sweep";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const runCatalogActivityEntry = z.object({
  purpose: runPurpose,
  shortcode: runShortcode,
  status: runStatus,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});

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
    /** Why the coordinator was permanently retired; `unrelated_source` erased its inputs. */
    retirementReason: runRetirementReason.nullable(),
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
        targetType: runTargetOutcomeReceipt.shape.target.shape.entityKind,
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
      error: z.string().nullable(),
      coordinatorStartedAt: z.iso.datetime().nullable(),
    }),
    progress: z.array(runProgress),
    latestProgress: runProgress.nullable(),
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

const runControlInput = z.object({
  runId: runShortcode,
  action: runControlAction,
  /**
   * `run_now_paid` only: the spend past a spent paid budget the member
   * confirmed, valid for the current six-hour window.
   */
  paidOverBudgetUsd: paidOverBudgetUsd.optional(),
});
const runRetryStepInput = z.object({
  runId: runShortcode,
  /** The RunStep key (`exif`, `statement_transaction`) whose failures run again. */
  stepKey: z.string().min(1),
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

export const runContract = defineContract(
  "run",
  {
    mailImport: query({
      description:
        "The member's connected Gmail mailboxes with their automatic Mail import switch and targeted-search progress. AI funding for the imports is household-wide: ai_funding_read.status.",
      input: z.strictObject({}),
      output: mailImportStatus,
      // Search progress moves while discovery runs; Run writes refresh it.
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    setMailImport: mutation({
      description:
        "Turn automatic Mail import on or off for one connected mailbox (state: run_read.mail_import). On, scheduled discovery searches known Vendors' senders and unmatched transaction merchants and imports unambiguous purchases within the household AI funding budgets (ai_funding_read.status), pausing until the next window once all are spent.",
      input: setMailImportInput,
      output: mailImportStatus,
      invalidates: ["runOnly"],
    }),
    sweep: mutation({
      description:
        "Start one Sweep over the chosen Suggestion families (statement_transaction and transfer_pair scoped by accountIds/since, recommendation by entityKinds, field by entity and fields; omitted scope covers everything). For statement_transaction, optional importId (TIM-code) reprocesses a retained collection under existing automatic policies, including enabled clean spending booking; accountIds/since intersect that collection. This can apply financial changes, not just filter suggestions. Returns the Sweep Run; follow it with run_read.work_snapshot and review results with suggestions_read.list. Model calls spend within the household AI budget and pause at it.",
      openWorld: true,
      input: sweepStartInput,
      output: z.object({ runId: runShortcode }),
      invalidates: ["runOnly"],
    }),
    sweepEstimate: query({
      exposure: "view",
      input: sweepStartInput,
      output: sweepEstimateOut,
    }),
    discoverMail: mutation({
      description:
        'Start Mail discovery now for one mailbox with Mail import on; replays an active launch. paidAllowed ("Run discovery now, paid allowed") resumes a paused discovery now; once the paid budget is spent it refuses unless paidOverBudgetUsd names the confirmed amount past it, which this discovery and the imports it starts may then spend. Use paidAllowed only on the member\'s explicit instruction.',
      openWorld: true,
      input: setMailImportInput.pick({ mailboxId: true }).extend({
        /** Skip the wait for free AI capacity; spend from the paid budget. */
        paidAllowed: z.boolean().optional(),
        paidOverBudgetUsd: paidOverBudgetUsd.optional(),
      }),
      output: mailboxDiscoveryStartOutput,
      invalidates: ["runOnly"],
    }),
    transcript: query({
      description:
        "Read one owned Run's committed coordinator messages, tool inputs/results/errors and submission settlements without loading or resuming execution. Both arrays are paged in chronological order; pass nextCursor as cursor until null. Defaults to 5 entries per array, at most 20. Live generation partials, credentials and binary bodies are omitted. Discovery Workflows have no coordinator conversation and return absent; read their persisted evidence with run_status. Absent means no retained conversation; it does not prove the Run never executed. Unfinished conversations may change between pages.",
      input: z.object({
        runId: runShortcode,
        cursor: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      output: agentConversationSchema.extend({
        nextCursor: z.number().int().nonnegative().nullable(),
      }),
      readPolicy: "strong",
    }),
    workSnapshot: query({
      description:
        "One Run's live state: status, counts, findings (each `id` is what activity.resolve_run_finding takes; activity_read.report shows a proposed fix), each target's outcome (`warning` holds a skip's reason), progress history, write operations, and stepFailures (each failed step's scrubbed error sample). An owned discovery Run also returns mailDiscovery: a paged emails audit (emailCursor/emailLimit, follow nextCursor), execution-time outcomes/ownership alongside current Email state, explicitly incomplete historical coverage, frozen mailbox scope and current mailbox coverage summarized as query counts with the next pending queries, persisted Workflow checkpoint with its in-flight page as counts, recorded AI usage/retries, and failure diagnostics. Reads stored evidence only; it never loads or resumes execution. An owned relevance reclassification Run returns mailReclassification: selected Email codes/checksums, durable publication receipts (null for legacy Runs), retained possibly truncated notes, and separately labeled classification observations that are not publication receipts. After a client timeout, read receipts before rerunning; historical completed receipts can include deferred work with linked recovery. Failed or absent receipts have unknown publication outcomes and require reconciliation before retrying. Read this to follow a run instead of polling entity_read.",
      nativeModels: { output: "json" },
      input: z.object({
        runId: runShortcode,
        emailCursor: z.number().int().nonnegative().default(0),
        emailLimit: z.number().int().min(1).max(200).default(50),
      }),
      output: z.object({
        runId: runShortcode,
        purpose: runPurpose,
        status: runStatus,
        startedAt: z.iso.datetime(),
        endedAt: z.iso.datetime().nullable(),
        retirementReason: runDetail.shape.retirementReason,
        coordinatorModel: z.string().nullable(),
        agentModelMs: z.number().nonnegative(),
        ordersSeen: z.number().int(),
        imported: z.number().int(),
        updated: z.number().int(),
        skipped: z.number().int(),
        findings: runDetail.shape.findings,
        targetsTotal: z.number().int(),
        targetsCompleted: z.number().int(),
        workProgress: runWorkProgress,
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
        /** Steps with failures and their newest scrubbed error sample. */
        stepFailures: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            failed: z.number().int().nonnegative(),
            errors: runStepErrors,
          }),
        ),
        /** Durable publication receipts; absent on legacy Runs. */
        mailReclassification: mailReclassificationRead.nullable(),
        /**
         * Persisted Workflow evidence; mailbox coverage may advance after this
         * Run. Query lists are summarized: hundreds of entries would swamp a
         * status read.
         */
        mailDiscovery: z
          .object({
            scope: z.object({
              mailboxId: z.string(),
              scopedQueries: mailboxQueryListSummary.nullable(),
              executionPolicy: z
                .enum(["classification_only", "import"])
                .nullable(),
            }),
            emails: discoveryEmailAuditPage,
            checkpoint: mailboxDiscoveryProgressSummary.nullable(),
            mailbox: z.object({
              historyId: z.string().nullable(),
              coverage: mailboxCoverageSummary.nullable(),
            }),
            failureCode: z.string().nullable(),
            error: z.string().nullable(),
            /** Recorded AI calls only. */
            usage: aiRunUsageOut
              .omit({ records: true, tokensByModel: true, nextCursor: true })
              .extend({
                callCount: z.number().int().nonnegative(),
                retryCount: z.number().int().nonnegative(),
              }),
          })
          .nullable(),
      }),
      cache: { tags: [] },
    }),
    catalogActivity: query({
      exposure: "view",
      input: z.null(),
      output: z.object({
        latest: z.array(runCatalogActivityEntry),
        completed: z.array(runCatalogActivityEntry),
      }),
      cache: { tags: [["run"]] },
    }),
    history: query({
      exposure: "view",
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
      exposure: "view",
      nativeModels: { output: "json" },
      input: z.object({ runId: runShortcode }),
      output: runDetail,
      cache: { tags: [["run"]] },
    }),
    commitPrepared: mutation({
      description:
        "Commit a Run's prepared import batch with its per-line Product and trade decisions, as purchase_import.commit does.",
      input: commitPurchaseImportInput.omit({ _runExecution: true }).extend({
        runId: runShortcode,
        operationId:
          commitPurchaseImportInput.shape._runExecution.shape.operationId,
      }),
      output: commitPurchaseImportOut,
      invalidates: ["runOnly", "purchase", "product"],
    }),
    control: mutation({
      exposure: "view",
      note: "MCP reserves `action`, so agents name it controlAction",
      command: {
        label: "Update Run",
        confirmation: null,
        navigateRunPath: "successor.publicId",
      },
      nativeModels: { input: "json", output: "json" },
      input: runControlInput,
      output: runControlOutput,
      invalidates: ["runOnly"],
    }),
    retryStep: mutation({
      description:
        "Retry one failed step in a Run after correcting its cause. Inspect Run status and findings first; retrying may repeat that step’s external or stored side effects.",
      command: { label: "Retry step", confirmation: null },
      input: runRetryStepInput,
      output: z.object({ run: runDetail }),
      invalidates: ["runOnly"],
    }),
    lifecycle: mutation({
      description:
        "Control an owned Run with controlAction: cancel stops active work; retry/restart preserve the previous attempt and return its admitted successor; pause, resume, escalate_sol, retry_dispatch, abort, upload_evidence and no_evidence_available follow the Run page. run_now_paid resumes a paused Mail import or Mail discovery Run now with paid models allowed for that Run, within the paid budget; once the window's paid budget is spent it refuses unless paidOverBudgetUsd names the confirmed amount past it. It spends money: use it only on the member's explicit instruction. Unsupported states refuse without changing the Run.",
      destructive: true,
      openWorld: true,
      input: runControlInput
        .omit({ action: true })
        .extend({ controlAction: runControlAction }),
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
      description:
        "Read raw diagnostic log lines for one Run. Use work_snapshot for progress and findings; logs are lower-level troubleshooting evidence.",
      input: z.object({ runId: runShortcode }),
      output: z.object({
        entries: z.array(runLogEntry),
        truncated: z.boolean(),
      }),
      cache: { tags: [["run"]] },
    }),
    /** The member's purchase-import agent OAuth grant. */
    agentConnection: query({
      exposure: "internal",
      input: z.undefined(),
      output: agentConnection,
      cache: { tags: [["run"]] },
    }),
    /** Revokes the grant and pauses the runs it authorized. */
    disconnectAgent: mutation({
      exposure: "internal",
      input: z.undefined(),
      output: agentConnection,
      invalidates: ["runOnly"],
    }),
    aiUsage: query({
      exposure: "view",
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
      exposure: "view",
      input: z.object({
        run: runShortcode,
        image: imageShortcode,
        state: runTargetDeviceWorkState,
        error: z.string().min(1).max(2000).optional(),
      }),
      output: z.object({ recorded: z.boolean() }),
    }),
  },
  { exposure: "capability" },
);
