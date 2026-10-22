// Type-only RPC contracts keep global Worker environment inference isolated from
// runtime implementations. worker-environment.d.ts checks this map against exports.
import type { Rpc } from "@cloudflare/workers-types";

import type { ChatGptPlanRpc } from "./ai/chatgpt/rpc";
import type { AiResponseCacheRpc } from "./ai/response-cache-rpc";
import type { DatabaseFreshnessRpc } from "./db/freshness/rpc";
import type { CalendarFeedDurableObjectRpc } from "./domains/calendar/operations/rpc";
import type { ImageProcessingCompanionRpc } from "./domains/image-processing/service/contracts";
import type { PurchaseImportRunAgentRpc } from "./domains/purchase-agent/service/environment";
import type { UsdaReleaseRpc } from "./domains/usda-release/operations/rpc";

export type AiResponseCacheDurableObject = AiResponseCacheRpc &
  Rpc.DurableObjectBranded;
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

export type AiGatewayEgressDurableObject =
  import("./ai/gateway-egress-contract").AiGatewayEgressRpc &
    Rpc.DurableObjectBranded;

export interface WorkerRpc {
  AiGatewayEgressDurableObject: AiGatewayEgressDurableObject;
  AiResponseCacheDurableObject: AiResponseCacheDurableObject;
  ChatGptPlanDurableObject: ChatGptPlanDurableObject;
  CalendarFeedDurableObject: CalendarFeedDurableObject;
  DatabaseFreshnessDurableObject: DatabaseFreshnessDurableObject;
  ImageProcessingDurableObject: ImageProcessingDurableObject;
  PurchaseImportRunAgent: PurchaseImportRunAgent;
  UsdaReleaseDurableObject: UsdaReleaseDurableObject;
}

type Worker = typeof import("../../cloudflare.config").productionWorker;
type LiveExport = {
  [E in keyof Worker["exports"]]: Worker["exports"][E] extends {
    state: "deleted";
  }
    ? never
    : E;
}[keyof Worker["exports"]];
/** A new live export must supply its isolated RPC contract. */
export type ConfiguredWorkerRpc = { [E in LiveExport]: WorkerRpc[E] };
