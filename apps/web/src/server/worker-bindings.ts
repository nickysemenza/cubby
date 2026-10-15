// Types only. worker-configuration.d.ts types the Worker's Durable Object and
// Workflow bindings from here (tooling/checks/worker-type-imports.ts rewrites
// Wrangler's `import("./src/cf-server")`). That file is a global script, and
// tsc re-checks the whole program after an edit to anything it reaches, so
// each binding names a type-only RPC interface whose module imports nothing
// but schema types (`git show 18f8bd430:docs/reports/local-check-performance.md`).
import type { Rpc } from "@cloudflare/workers-types";
import type { SearchIndexRepairCounters } from "@cubby/schemas/maintenance";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { ChatGptPlanRpc } from "./ai/chatgpt/rpc";
import type { DatabaseFreshnessRpc } from "./db/freshness/rpc";
import type { CalendarFeedDurableObjectRpc } from "./domains/calendar/rpc";
import type { ImageProcessingCompanionRpc } from "./domains/image-processing/contracts";
import type { PurchaseImportRunAgentRpc } from "./domains/purchase-agent/environment";
import type { UsdaReleaseRpc } from "./domains/usda-release/rpc";
import type { WorkflowRunParams } from "./workflows/runs/contract";

// Its implementation imports nothing from the app.
export type { AiResponseCacheDurableObject } from "./ai/response-cache-durable-object";
export type ChatGptPlanDurableObject = ChatGptPlanRpc &
  Rpc.DurableObjectBranded;

export type CalendarFeedDurableObject = CalendarFeedDurableObjectRpc &
  Rpc.DurableObjectBranded;
export type DatabaseFreshnessDurableObject = DatabaseFreshnessRpc &
  Rpc.DurableObjectBranded;
export type ImageProcessingDurableObject = ImageProcessingCompanionRpc &
  Rpc.DurableObjectBranded;
export type PurchaseImportRunAgent = PurchaseImportRunAgentRpc &
  Rpc.DurableObjectBranded;
export type UsdaReleaseDurableObject = UsdaReleaseRpc &
  Rpc.DurableObjectBranded;

export interface SearchIndexRepairWorkflowParams {
  readonly requestedAt: string;
}

/** The entrypoint shape the `SEARCH_INDEX_REPAIR` binding's params come from. */
export interface SearchIndexRepairWorkflow {
  run(
    event: Readonly<WorkflowEvent<SearchIndexRepairWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<SearchIndexRepairCounters>;
}

/** The `MAIL_DISCOVERY` binding: one scheduled `mail_discovery` Run attempt. */
export interface MailDiscoveryWorkflow {
  run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ): Promise<{ runId: string }>;
}

export type AiGatewayEgressDurableObject =
  import("./ai/gateway-egress-contract").AiGatewayEgressRpc &
    Rpc.DurableObjectBranded;

export type AiRefreshWorkflow = MailDiscoveryWorkflow;
