/**
 * The input contract of the web Worker's private `PurchaseImportService` RPC
 * (`apps/web/src/cf-server.ts`), as called by the Flue Worker
 * (`apps/purchase-agent`). Both sides take their types from these schemas
 * (`z.infer`), so a field added on one side cannot be forgotten on the other.
 * Every method resolves authority from the Run; none accepts a party, account,
 * vendor, SQL, script, or generic mutation target.
 */
import { z } from "zod";

export const purchaseAgentRunRef = z.object({ runId: z.string() });

export const purchaseAgentOperationRef = purchaseAgentRunRef.extend({
  operationId: z.string(),
});

export const purchaseAgentEventRef = purchaseAgentRunRef.extend({
  eventId: z.string(),
});

/** The model's semantic browser request, before the server selects the URL. */
export const purchaseAgentCommand = z.object({
  kind: z.enum([
    "navigate_orders",
    "capture_order",
    "capture_pdf",
    "capture_screenshot",
  ]),
  target: z.string().optional(),
});
export type PurchaseAgentCommand = z.infer<typeof purchaseAgentCommand>;

export const issueBrowserCommandInput = purchaseAgentOperationRef.extend({
  command: purchaseAgentCommand,
});

export const importOrderEvidenceInput = purchaseAgentOperationRef.extend({
  commandId: z.string(),
});

export const saveNavigationHintsInput = purchaseAgentOperationRef.extend({
  hints: z.array(z.object({ url: z.string(), label: z.string().optional() })),
});

export const markHistoryExpiredInput = purchaseAgentOperationRef.extend({
  earliestAvailableOrderAt: z.string(),
});

export const auditBatchInput = purchaseAgentOperationRef.extend({
  offset: z.number(),
});

export const stopForReviewInput = purchaseAgentOperationRef.extend({
  reason: z.enum([
    "navigation_ambiguity",
    "unreadable_evidence",
    "provider_failure",
    "other",
  ]),
  detail: z.string().optional(),
});

export const markRunFailedInput = purchaseAgentOperationRef.extend({
  failureCode: z.enum(["flue_failed", "flue_aborted"]),
  detail: z.string().optional(),
  dispatchEventId: z.string().optional(),
});

export const reconcileSettledRunInput = purchaseAgentOperationRef.extend({
  detail: z.string().optional(),
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
