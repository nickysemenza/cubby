// Types only. worker-configuration.d.ts types the Worker's Durable Object and
// Workflow bindings from here (scripts/worker-type-imports.ts rewrites
// Wrangler's `import("./src/cf-server")`). That file is a global script, and
// TypeScript re-checks the whole program whenever a global file falls in an
// edit's importer closure, so nothing here may reach the server graph: the
// heavy Durable Objects bind through the RPC interfaces they implement.
// docs/local-check-performance.md#typechecking
import type { Rpc } from "@cloudflare/workers-types";
import type { SearchIndexRepairCounters } from "@cubby/schemas/maintenance";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { CalendarFeedDurableObjectRpc } from "./calendar/contracts";
import type { DatabaseFreshnessRpc } from "./database-freshness/state";
import type { ImageProcessingCompanionRpc } from "./image-processing/contracts";

// Their implementations reach only a handful of files.
export type { AiResponseCacheDurableObject } from "./ai/response-cache-durable-object";
export type { PurchaseImportDurableObject } from "./purchase-import/durable-object";

export type CalendarFeedDurableObject = CalendarFeedDurableObjectRpc &
  Rpc.DurableObjectBranded;
export type DatabaseFreshnessDurableObject = DatabaseFreshnessRpc &
  Rpc.DurableObjectBranded;
export type ImageProcessingDurableObject = ImageProcessingCompanionRpc &
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
