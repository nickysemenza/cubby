// Types only. worker-configuration.d.ts types the Worker's Durable Object and
// Workflow bindings from here (scripts/worker-type-imports.ts rewrites
// Wrangler's `import("./src/cf-server")`). That file is a global script, and
// tsc re-checks the whole program after an edit to anything it reaches, so
// each binding names a type-only RPC interface whose module imports nothing
// but schema types (docs/local-check-performance.md#typechecking).
import type { Rpc } from "@cloudflare/workers-types";
import type { SearchIndexRepairCounters } from "@cubby/schemas/maintenance";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { CalendarFeedDurableObjectRpc } from "./calendar/rpc";
import type { DatabaseFreshnessRpc } from "./database-freshness/rpc";
import type { ImageProcessingCompanionRpc } from "./image-processing/contracts";
import type { PurchaseImportDurableObjectRpc } from "./purchase-import/rpc";

// Its implementation imports nothing from the app.
export type { AiResponseCacheDurableObject } from "./ai/response-cache-durable-object";

export type CalendarFeedDurableObject = CalendarFeedDurableObjectRpc &
  Rpc.DurableObjectBranded;
export type DatabaseFreshnessDurableObject = DatabaseFreshnessRpc &
  Rpc.DurableObjectBranded;
export type ImageProcessingDurableObject = ImageProcessingCompanionRpc &
  Rpc.DurableObjectBranded;
export type PurchaseImportDurableObject = PurchaseImportDurableObjectRpc &
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
