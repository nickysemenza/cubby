"use agent";

import {
  useInitialData,
  useAgentFinish,
  useDelivery,
  useModel,
  useResponseFinish,
  useResponseStart,
  useTool,
  observe,
  type AgentProps,
} from "@flue/runtime";
import * as v from "valibot";

import { purchaseImportAgentIdentity } from "./contracts";
import { serviceForCurrentRun } from "./cloudflare-service";
import { purchaseImportTools } from "./tools";
import { purchaseImportService } from "./service";

observe((event, context) => {
  if (
    event.type !== "submission_settled" ||
    event.outcome === "completed" ||
    !event.instanceId?.startsWith("import-run:")
  )
    return;
  const runId = event.instanceId.slice("import-run:".length);
  return purchaseImportService(context.env)
    .markRunFailed({
      runId,
      operationId: `submission-settled:${event.submissionId}`,
      failureCode: event.outcome === "aborted" ? "flue_aborted" : "flue_failed",
      detail: event.error?.message,
    })
    .then(() => undefined);
});

type ImportRunInitialData = { runId: string };

/** One durable Flue conversation per authoritative ImportRun. */
export function PurchaseImportRun({ id }: AgentProps) {
  const { runId } = useInitialData<ImportRunInitialData>();
  const delivery = useDelivery();
  if (id !== purchaseImportAgentIdentity(runId)) {
    throw new Error(
      "Purchase import agent identity does not match its ImportRun",
    );
  }

  useModel("cubby/gpt-5.6-luna");
  useResponseStart(() => ({
    jobKind: "purchase_import_run",
    runId,
  }));
  useResponseFinish(({ response }) => ({
    usage: response.usage,
  }));
  useAgentFinish(async ({ response, log }) => {
    const eventId =
      delivery.kind === "signal"
        ? (delivery.attributes?.eventId ?? delivery.type)
        : "direct";
    const usage = response.usage;
    try {
      await serviceForCurrentRun().recordOrchestrationUsage({
        runId,
        operationId: `orchestration-usage:${eventId}:${usage.totalTokens}`,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        estimatedCost: usage.cost.total,
      });
    } catch (error) {
      log.error("purchase import orchestration usage was not recorded", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  });
  const tools = purchaseImportTools(runId, serviceForCurrentRun);
  useTool(tools[0]);
  useTool(tools[1]);
  useTool(tools[2]);
  useTool(tools[3]);
  useTool(tools[4]);
  useTool(tools[5]);
  useTool(tools[6]);
  useTool(tools[7]);
  useTool(tools[8]);
  useTool(tools[9]);

  return `You coordinate exactly one purchase import run (${runId}). Start by loading its scope, then claim server-selected work. Continue every selected order or hunt until it is imported, explicitly exhausted, or stopped for review; do not treat one imported order as the end of an account scan. You may only use the listed typed tools; never infer ownership, alter browser authority, issue scripts, use shell/SQL, or make generic mutations. Browser commands are read-only. If a browser command result is pending, the tool terminates this submission; do not wait or retry it in this submission. A later queue event resumes this same durable agent. Authentication and offline conditions are resumable server states. If evidence is ambiguous, unreadable, or provider behavior prevents a confident import, call stop_for_review and do not speculate. Call audit_batch for each server-reported page before finishing; finish_run independently enforces full audit coverage and rejects unsettled hunt work. Finish only after the server reports no more work.`;
}

PurchaseImportRun.agentName = "purchase-import-run";
PurchaseImportRun.initialData = v.object({
  runId: v.pipe(v.string(), v.uuid()),
});
PurchaseImportRun.durability = { maxAttempts: 8, timeoutMs: 55 * 60 * 1_000 };
