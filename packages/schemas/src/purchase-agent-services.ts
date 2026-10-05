/**
 * The input contract of the run-scoped services the purchase agent calls
 * (`apps/web/src/server/purchase-import/agent-services.ts`). The agent reads
 * untrusted vendor pages, mail, and photos, so the host parses every input
 * with these schemas before it reaches the database. No input names a Run:
 * each service is bound to one Run when the host creates it, and none accepts
 * a party, account, vendor, SQL, script, or generic mutation target.
 */
import { z } from "zod";

import { tradeSchema } from "./task-fields";

export const purchaseAgentOperationRef = z.object({
  operationId: z.string().min(1).max(256),
});

export const purchaseAgentEventRef = z.object({
  eventId: z.string().min(1).max(256),
});

/** The model's semantic browser request, before the server selects the URL. */
export const purchaseAgentCommand = z.object({
  kind: z.enum([
    "navigate_orders",
    "capture_order",
    "capture_pdf",
    "capture_screenshot",
  ]),
  target: z.string().max(2_048).optional(),
});
export type PurchaseAgentCommand = z.infer<typeof purchaseAgentCommand>;

export const issueBrowserCommandInput = purchaseAgentOperationRef.extend({
  command: purchaseAgentCommand,
});

export const importOrderEvidenceInput = purchaseAgentOperationRef.extend({
  commandId: z.uuid(),
  /** As for `purchase_import.commit`: a principal line needs a trade. */
  defaultTrade: tradeSchema.optional(),
  /** A Project shortcode, resolved and authorized by the host. */
  defaultProjectId: z.string().min(1).optional(),
});

export const saveNavigationHintsInput = purchaseAgentOperationRef.extend({
  hints: z
    .array(
      z.object({
        url: z.url().max(2_048),
        label: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(25),
});

export const markHistoryExpiredInput = purchaseAgentOperationRef.extend({
  earliestAvailableOrderAt: z.iso.datetime({ offset: true }),
});

export const stopForReviewInput = purchaseAgentOperationRef.extend({
  reason: z.enum([
    "navigation_ambiguity",
    "unreadable_evidence",
    "provider_failure",
    "other",
  ]),
  detail: z.string().min(1).max(1_000).optional(),
});

export const deferOrderForReviewInput = purchaseAgentOperationRef.extend({
  orderId: z.string().min(1).max(200),
  detail: z.string().min(1).max(1_000),
});

/**
 * Record a selected charge hunt's outcome when its evidence did not settle it:
 * no matching order was found, or one stayed ambiguous and needs review.
 */
export const settleChargeHuntInput = purchaseAgentOperationRef.extend({
  huntId: z.uuid(),
  outcome: z.enum(["not_found", "needs_review"]),
  detail: z.string().min(1).max(1_000),
});

export const markRunFailedInput = purchaseAgentOperationRef.extend({
  failureCode: z.enum(["agent_failed", "agent_aborted"]),
  detail: z.string().optional(),
  dispatchEventId: z.string().optional(),
});

export const reconcileSettledRunInput = purchaseAgentOperationRef.extend({
  detail: z.string().optional(),
  /** Every queue event id the agent has received for this run. */
  receivedEventIds: z.array(z.string().min(1)).max(10_000),
  /** The settled submission went unanswered: fail the run, not review it. */
  failure: markRunFailedInput
    .pick({ failureCode: true, detail: true })
    .optional(),
});

/** One model turn's token and cost accounting, recorded once per `eventId`. */
export const agentUsageEvent = purchaseAgentEventRef.extend({
  provider: z.string(),
  model: z.string(),
  feature: z.literal("purchase_import_agent"),
  operation: z.string(),
  attempt: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  durationMs: z.number(),
  status: z.enum(["succeeded", "failed"]),
  gatewayLogId: z.string().optional(),
  estimatedCost: z.number().optional(),
});
export type AgentUsageEvent = z.infer<typeof agentUsageEvent>;

/** A coordinator progress breadcrumb, deduplicated by `(runId, eventId)`. */
export const agentProgressEvent = z.object({
  runId: z.uuid(),
  eventId: z.string().trim().min(1).max(256),
  phase: z.string().trim().min(1).max(200),
  currentItem: z.string().trim().min(1).max(500).optional(),
  awaitingApproval: z.boolean().optional(),
  detail: z.string().trim().min(1).max(2_000).optional(),
});
export type AgentProgressEvent = z.infer<typeof agentProgressEvent>;

/** The run-scoped form the agent reports; the host supplies the Run. */
export const agentProgressReport = agentProgressEvent.omit({ runId: true });

/** The phases the model may report; the host also accepts its own. */
const agentProgressPhase = z.enum([
  "preparing",
  "investigating",
  "awaiting_browser",
  "awaiting_approval",
  "committing",
  "review",
  "complete",
]);

/**
 * The model's operation id. Each tool prefixes it with its own namespace
 * (`browser-command:`, `agent-progress-review:`, …) before calling the host,
 * so it stays under the host's 256 with room for the longest prefix.
 */
const modelId = {
  operationId: purchaseAgentOperationRef.shape.operationId.max(200),
};
const modelOperationRef = z.object(modelId);

/**
 * The inputs of the agent's typed tools (`server/purchase-agent/tools.ts`),
 * keyed by tool name and published to the model as their JSON Schema. Each is
 * its host contract above, narrowed where the model gets less: the shorter
 * operation id, and for progress the closed phase list and 1,000-character
 * detail instead of the host's open phase text and 2,000.
 */
export const purchaseAgentToolInputs = {
  claim_next_import_work: modelOperationRef,
  extract_receipt_evidence: modelOperationRef,
  extract_run_evidence: modelOperationRef,
  issue_browser_command: issueBrowserCommandInput.extend(modelId),
  read_browser_command_result: modelOperationRef,
  import_browser_order_evidence: importOrderEvidenceInput.extend(modelId),
  report_agent_progress: modelOperationRef.extend({
    phase: agentProgressPhase,
    currentItem: agentProgressReport.shape.currentItem,
    awaitingApproval: agentProgressReport.shape.awaitingApproval,
    detail: agentProgressReport.shape.detail.unwrap().max(1_000).optional(),
  }),
  save_navigation_hints: saveNavigationHintsInput.extend(modelId),
  mark_history_expired: markHistoryExpiredInput.extend(modelId),
  finish_import_run: modelOperationRef,
  stop_import_run_for_review: stopForReviewInput.extend(modelId),
  defer_order_for_review: deferOrderForReviewInput.extend(modelId),
  settle_charge_hunt: settleChargeHuntInput.extend(modelId),
};
