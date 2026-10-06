// Types only. worker-configuration.d.ts types the Worker's Durable Object and
// Workflow bindings from here (scripts/worker-type-imports.ts rewrites
// Wrangler's `import("./src/cf-server")`). That file is a global script, and
// tsc re-checks the whole program after an edit to anything it reaches, so
// each binding names a type-only RPC interface whose module imports nothing
// but schema types (docs/local-check-performance.md#typechecking).
import type { Rpc } from "@cloudflare/workers-types";
import type { SearchIndexRepairCounters } from "@cubby/schemas/maintenance";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { ChatGptPlanRpc } from "./ai/chatgpt/rpc";
import type { CalendarFeedDurableObjectRpc } from "./calendar/rpc";
import type { DatabaseFreshnessRpc } from "./database-freshness/rpc";
import type { ImageProcessingCompanionRpc } from "./image-processing/contracts";
import type { PurchaseImportRunAgentRpc } from "./purchase-agent/environment";
import type { PurchaseImportDurableObjectRpc } from "./purchase-import/rpc";
import type { WorkflowRunParams } from "./workflow-runs/contract";

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
export type PurchaseImportDurableObject = PurchaseImportDurableObjectRpc &
  Rpc.DurableObjectBranded;
export type PurchaseImportRunAgent = PurchaseImportRunAgentRpc &
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

/** The `VENDOR_MAIL_SEARCH` binding: one `mail_search` Run attempt. */
export interface VendorMailSearchWorkflow {
  run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ): Promise<{ runId: string }>;
}

/** The `MAIL_DISCOVERY` binding: one scheduled `mail_discovery` Run attempt. */
export interface MailDiscoveryWorkflow {
  run(
    event: Readonly<WorkflowEvent<WorkflowRunParams>>,
    step: WorkflowStep,
  ): Promise<{ runId: string }>;
}
