import { activityExecutor } from "@cubby/schemas/activity";
import { z } from "zod";

import { importRunPublicId } from "~/lib/purchase-import-run-detail";

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

const purchaseImportRunLogEntry = z.object({
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

export const purchaseImportRunLogResponse = z.object({
  entries: z.array(purchaseImportRunLogEntry),
  truncated: z.boolean(),
});

export const purchaseImportRunLogRequest = z.union([
  z.object({ publicId: importRunPublicId }),
  // Legacy Settings entries predate public PIR addresses. New detail routes
  // use the public-id branch; this preserves older local history links.
  z.object({ runId: z.uuid() }),
]);

export type PurchaseImportRunLogEntry = z.infer<
  typeof purchaseImportRunLogEntry
>;
