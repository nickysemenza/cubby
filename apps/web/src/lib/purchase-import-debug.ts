import { activityExecutor } from "@cubby/schemas/activity";
import { z } from "zod";

const purchaseImportDebugEventName = z.enum([
  "connect.requested",
  "replay.loaded",
  "connection.attempt",
  "connection.ready",
  "connection.retry",
  "disconnect.requested",
  "message.received",
  "command.started",
  "command.duplicate_suppressed",
  "command.result_replayed",
  "command.finished",
  "apple_event.started",
  "apple_event.finished",
  "apple_event.rejected",
  "apple_event.failed",
  "result.persisted",
  "result.sent",
  "result.send_deferred",
  "ack.received",
  "cancel.received",
  "run.completed",
  "controller.roster",
  "controller.status",
  "sync.requested",
]);

const safeMetadata = z
  .string()
  .max(253)
  .regex(/^[\w.:=-]+$/u);

export const purchaseImportDebugEvent = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  event: purchaseImportDebugEventName,
  runId: z.uuid(),
  commandId: z.uuid().nullable().optional(),
  operationId: z.string().min(1).max(200).nullable().optional(),
  operationKind: z
    .enum(["navigate", "follow_captured_link", "scroll", "capture"])
    .nullable()
    .optional(),
  host: z.hostname().nullable().optional(),
  browser: z.enum(["chrome", "safari"]).nullable().optional(),
  accountID: safeMetadata.nullable().optional(),
  attempt: z.number().int().min(0).max(1_000).nullable().optional(),
  count: z.number().int().min(0).max(100_000).nullable().optional(),
  outcome: safeMetadata.nullable().optional(),
  messageType: safeMetadata.nullable().optional(),
  errorType: safeMetadata.nullable().optional(),
  errorCode: z.number().int().min(-100_000).max(100_000).nullable().optional(),
  // Device identity is accepted only by the actor-owned run ingestion route.
  executor: activityExecutor.nullable().optional(),
});

export const purchaseImportDebugEventsRequest = z.object({
  events: z.array(purchaseImportDebugEvent).min(1).max(100),
});

export const purchaseAgentConnectionStatus = z.enum([
  "authorized",
  "denied",
  "failed",
  "dispatch_failed",
]);
export type PurchaseAgentConnectionStatus = z.infer<
  typeof purchaseAgentConnectionStatus
>;
