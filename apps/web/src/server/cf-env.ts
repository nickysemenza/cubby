// Access to the CF Workers env (service bindings) outside the fetch handler.
//
// Module-level storage is safe here — unlike the per-request pg.Pool in
// db.ts, `env` is the same object for every request in an isolate. Both local
// workerd and deployed Workers set it; scripts and isolated tests outside the
// Worker adapter can leave it undefined.

import { AsyncLocalStorage } from "node:async_hooks";

import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";

import type { PurchaseAgentQueueProducer } from "./domains/purchase-agent/service/purchase-agent-queue-types";
import type { VectorizeIndexBinding } from "./generic/embedding/service/semantic/vector-store";
import type { TelemetryQueueProducer } from "./observability/telemetry-queue-types";
import type { BackgroundQueueProducer } from "./workflows/background-queue-types";

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
  origin?: string;
}

/**
 * AsyncLocalStorage rather than the module-level slot `env` uses above: the
 * execution context is PER REQUEST. A module-level one would be overwritten by
 * whichever request landed last in the isolate, and calling waitUntil on a
 * context whose request already settled throws.
 */
const executionCtxStore = new AsyncLocalStorage<WaitUntilContext>();

export const runWithExecutionCtx = <T>(
  ctx: WaitUntilContext,
  fn: () => Promise<T>,
  origin?: string,
): Promise<T> =>
  executionCtxStore.run(
    { waitUntil: (task) => ctx.waitUntil(task), origin },
    fn,
  );

/** Undefined outside a Worker fetch request, including queue/cron invocations. */
export const getExecutionCtx = (): WaitUntilContext | undefined =>
  executionCtxStore.getStore();

let cfEnv: Env | undefined;

export const setCfEnv = (env?: Env): void => {
  cfEnv = env;
};

/** True after the request has entered the Cloudflare Worker adapter. */
export const isCloudflareRuntime = (): boolean => cfEnv !== undefined;

/** Durable search-index repair binding when configured in the Worker environment. */
export const getSearchIndexRepairWorkflow = ():
  | Env["SEARCH_INDEX_REPAIR"]
  | undefined => cfEnv?.SEARCH_INDEX_REPAIR;

/** The Workflow that runs one scheduled `mail_discovery` pass. */
export const getMailDiscoveryWorkflow = (): Env["MAIL_DISCOVERY"] | undefined =>
  cfEnv?.MAIL_DISCOVERY;

/**
 * The background queue producer (`env.BACKGROUND_QUEUE`) on local or deployed
 * Workers, or undefined outside the Worker adapter. The binding
 * is declared in cloudflare.config.ts; this accessor narrows it to the producer
 * surface shared by production and tests.
 */
export const getBackgroundQueue = (): BackgroundQueueProducer | undefined => {
  // SAFETY: native configuration infers Env bindings structurally;
  // this adapter narrows that generated queue binding to Cubby's owned port.
  return cfEnv?.BACKGROUND_QUEUE as BackgroundQueueProducer | undefined;
};

/** The low-priority telemetry queue when configured in the Worker environment. */
export const getTelemetryQueue = (): TelemetryQueueProducer | undefined => {
  // SAFETY: native configuration infers Env bindings structurally;
  // this adapter narrows that generated queue binding to Cubby's owned port.
  return cfEnv?.TELEMETRY_QUEUE as TelemetryQueueProducer | undefined;
};

export const getImageCloudQueue = (): BackgroundQueueProducer | undefined => {
  // SAFETY: native configuration infers this binding; the port narrows sendBatch.
  return cfEnv?.IMAGE_CLOUD_QUEUE as BackgroundQueueProducer | undefined;
};

/** Queue producer for the per-run purchase-import agent's events. */
export const getPurchaseAgentQueue = ():
  | PurchaseAgentQueueProducer
  | undefined => {
  // SAFETY: cloudflare.config.ts declares this queue binding; this
  // adapter narrows it to the single send method Cubby's producer owns.
  return cfEnv?.PURCHASE_AGENT_QUEUE as PurchaseAgentQueueProducer | undefined;
};

/** Worker secrets are not part of the generated Wrangler Env type. */
export const getGmailOAuthCredentials = () => {
  if (!cfEnv) return undefined;
  // SAFETY: Wrangler secrets are runtime Env fields absent from generated binding types.
  const google = cfEnv as Env & {
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
  };
  return {
    clientId: google.GOOGLE_CLIENT_ID,
    clientSecret: google.GOOGLE_CLIENT_SECRET,
  };
};

/**
 * APNs token-auth credentials for photo-run Live Activity pushes: the key id,
 * team id, and the `.p8` PKCS8 PEM. Absent outside a configured Worker.
 */
export const getApnsCredentials = () => {
  if (!cfEnv) return undefined;
  // SAFETY: Wrangler secrets are runtime Env fields absent from generated binding types.
  const apns = cfEnv as Env & {
    APNS_KEY_ID?: string;
    APNS_TEAM_ID?: string;
    APNS_PRIVATE_KEY?: string;
  };
  if (!apns.APNS_KEY_ID || !apns.APNS_TEAM_ID || !apns.APNS_PRIVATE_KEY)
    return undefined;
  return {
    keyId: apns.APNS_KEY_ID,
    teamId: apns.APNS_TEAM_ID,
    privateKey: apns.APNS_PRIVATE_KEY,
  };
};

/** Origin-keyed durable calendar publishing state from the Worker environment. */
export const getCalendarFeedNamespace = (): Env["CALENDAR_FEED"] | undefined =>
  cfEnv?.CALENDAR_FEED;

/** The purchase agent's per-Run coordinators (`server/domains/purchase-import/operations/agent-host`). */
export const getPurchaseImportRunAgentNamespace = () =>
  cfEnv?.PURCHASE_IMPORT_RUN;

/** USDA release Durable Objects and the active release name (`server/domains/usda-release`). */
export const getUsdaReleaseEnv = ():
  | Pick<Env, "USDA_RELEASE" | "USDA_ACTIVE_RELEASE">
  | undefined => cfEnv;

/** Connected native image workers share this transport; job authority stays in Postgres. */
export const getImageProcessingNamespace = () => cfEnv?.IMAGE_PROCESSING;

/**
 * The optional Workers AI binding (`env.AI`) from the Worker environment. The
 * transport shim in `~/server/ai/gateway` runs Workers AI models on it
 * directly and reaches every other provider through `getAiGateway`.
 */
export const getAi = () => cfEnv?.AI;

/** The binding's Universal endpoint for Cubby's gateway (`env.AI.gateway("cubby")`). */
export const getAiGateway = (gatewayId: string = CUBBY_AI_GATEWAY_ID) =>
  cfEnv?.AI?.gateway(gatewayId);

/**
 * The deterministic gateway peer that exists only in the workerd harness's
 * offline and purchase-agent profiles (`tooling/workerd-harness.ts`). It is deliberately
 * absent from cloudflare.config.ts, so a deployed Worker can never resolve it and
 * keeps the mandatory `env.AI` transport above.
 */
export const getTestAiGateway = (): { fetch: typeof fetch } | undefined =>
  // SAFETY: the optional extension describes only the harness-only service
  // binding; generated production bindings cannot supply it.
  (
    cfEnv as
      | (Env & { CUBBY_TEST_AI_GATEWAY?: { fetch: typeof fetch } })
      | undefined
  )?.CUBBY_TEST_AI_GATEWAY;

/**
 * The optional entity-vector index (`env.VECTORIZE`) from the Worker
 * environment. Narrowed to Cubby's owned surface because the inferred binding
 * uses the legacy `VectorizeIndex` class, which omits `queryById`.
 */
export const getVectorIndex = (): VectorizeIndexBinding | undefined => {
  // SAFETY: the generated binding is the v2 Vectorize index at runtime; this
  // adapter narrows it to the methods Cubby calls.
  return cfEnv?.VECTORIZE as VectorizeIndexBinding | undefined;
};

export const getDatabaseFreshnessNamespace = () => cfEnv?.DB_FRESHNESS;

export const getAiResponseCacheNamespace = () => cfEnv?.AI_RESPONSE_CACHE;
export const getChatGptPlanNamespace = () => cfEnv?.CHATGPT_PLAN;

export const getAiGatewayEgress = (gatewayId: string) =>
  cfEnv?.AI_GATEWAY_EGRESS?.getByName(gatewayId);

export const getAiRefreshWorkflow = () => cfEnv?.AI_REFRESH;
export const getAiRefreshEnabled = () => cfEnv?.AI_REFRESH_ENABLED === "true";
