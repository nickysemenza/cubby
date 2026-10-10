/**
 * The input contract of the run-scoped services the purchase agent calls
 * (`apps/web/src/server/purchase-import/agent-services.ts`). The agent reads
 * untrusted vendor pages, mail, and photos, so the host parses every input
 * with these schemas before it reaches the database. No input names a Run:
 * each service is bound to one Run when the host creates it, and none accepts
 * a party, account, vendor, SQL, script, or generic mutation target.
 */
import { z } from "zod";

import { aiUsageTransport } from "./telemetry";

export const purchaseAgentOperationRef = z.object({
  operationId: z.string().min(1).max(256),
});

export const purchaseAgentEventRef = z.object({
  eventId: z.string().min(1).max(256),
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
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheReadTokens: z.number().nullable(),
  cacheWriteTokens: z.number().nullable(),
  durationMs: z.number(),
  status: z.enum(["succeeded", "failed"]),
  /** Selected before the request left; `unknown` if none was selected. */
  transport: aiUsageTransport,
  gatewayLogId: z.string().optional(),
  gatewayCacheStatus: z.enum(["hit", "miss"]).optional(),
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

/** Photo inventory retains its existing restricted workflow and replay keys. */
export const photoInventoryToolInputs = {
  claim_next_import_work: modelOperationRef,
  report_agent_progress: modelOperationRef.extend({
    phase: agentProgressPhase,
    currentItem: agentProgressReport.shape.currentItem,
    awaitingApproval: agentProgressReport.shape.awaitingApproval,
    detail: agentProgressReport.shape.detail.unwrap().max(1_000).optional(),
  }),
  stop_import_run_for_review: stopForReviewInput.extend(modelId),
};
