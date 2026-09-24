// Access to the CF Workers env (service bindings) outside the fetch handler.
//
// Module-level storage is safe here — unlike the per-request pg.Pool in
// db.ts, `env` is the same object for every request in an isolate. On the
// dev server (plain Node via vite) setCfEnv is never called, so accessors
// return undefined and callers fall back to public URLs + global fetch.

import { AsyncLocalStorage } from "node:async_hooks";

import type { BackgroundQueueProducer } from "./background-queue-types";
import type { PurchaseAgentQueueProducer } from "./purchase-agent-queue-types";
import type { VectorizeIndexBinding } from "./semantic/vector-store";
import type { TelemetryQueueProducer } from "./telemetry-queue-types";

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

/** Undefined outside a CF request (queue/cron invocations, the Node dev server). */
export const getExecutionCtx = (): WaitUntilContext | undefined =>
  executionCtxStore.getStore();

let cfEnv: Env | undefined;

export const setCfEnv = (env?: Env): void => {
  cfEnv = env;
};

/** True after the request has entered the Cloudflare Worker adapter. */
export const isCloudflareRuntime = (): boolean => cfEnv !== undefined;

/** Durable search-index repair binding; absent in plain Node/Vite development. */
export const getSearchIndexRepairWorkflow = ():
  | Env["SEARCH_INDEX_REPAIR"]
  | undefined => cfEnv?.SEARCH_INDEX_REPAIR;

/**
 * The background queue producer (`env.BACKGROUND_QUEUE`) on CF Workers, or
 * undefined on the dev Node server (where setCfEnv is never called). The binding
 * is generated from wrangler.jsonc; this accessor narrows it to the producer
 * surface shared by production and tests.
 */
export const getBackgroundQueue = (): BackgroundQueueProducer | undefined => {
  // SAFETY: Wrangler generates Env bindings structurally from configuration;
  // this adapter narrows that generated queue binding to Cubby's owned port.
  return cfEnv?.BACKGROUND_QUEUE as BackgroundQueueProducer | undefined;
};

/** The low-priority telemetry queue, or undefined in the Node dev server. */
export const getTelemetryQueue = (): TelemetryQueueProducer | undefined => {
  // SAFETY: Wrangler generates Env bindings structurally from configuration;
  // this adapter narrows that generated queue binding to Cubby's owned port.
  return cfEnv?.TELEMETRY_QUEUE as TelemetryQueueProducer | undefined;
};

/** Queue producer for the private per-run Flue purchase-import Worker. */
export const getPurchaseAgentQueue = ():
  | PurchaseAgentQueueProducer
  | undefined => {
  // SAFETY: Wrangler generates this queue binding from wrangler.jsonc; this
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

/** Origin-keyed durable calendar publishing state, absent in plain Vite. */
export const getCalendarFeedNamespace = (): Env["CALENDAR_FEED"] | undefined =>
  cfEnv?.CALENDAR_FEED;

export const getPurchaseImportNamespace = () => cfEnv?.PURCHASE_IMPORT;

/** Connected native image workers share this transport; job authority stays in Postgres. */
export const getImageProcessingNamespace = () => cfEnv?.IMAGE_PROCESSING;

// Cubby's Cloudflare account + AI Gateway identifiers. Single source of truth
// for the gateway binding (below) and the gateway-REST base URL built in
// `~/server/clients/ai-gateway`.
export const CF_ACCOUNT_ID = "9f10f078d35d86c78dedece2300a6b88";
export const CF_AIG_GATEWAY_ID = "cubby";

/**
 * The AI Gateway binding (`env.AI.gateway("cubby")`) on CF Workers, or undefined
 * on the dev Node server (where setCfEnv is never called). The one caller is the
 * transport shim in `~/server/clients/ai-gateway`, which authenticates via
 * Worker identity in prod and falls back to gateway-REST with
 * AI_GATEWAY_API_KEY in dev.
 */
export const getAiGateway = () => cfEnv?.AI?.gateway(CF_AIG_GATEWAY_ID);

/**
 * The entity-vector index (`env.VECTORIZE`) on CF Workers, or undefined on the
 * dev Node server. Narrowed to Cubby's owned surface because `wrangler types`
 * emits the legacy `VectorizeIndex` class, which omits `queryById`.
 */
export const getVectorIndex = (): VectorizeIndexBinding | undefined => {
  // SAFETY: the generated binding is the v2 Vectorize index at runtime; this
  // adapter narrows it to the methods Cubby calls.
  return cfEnv?.VECTORIZE as VectorizeIndexBinding | undefined;
};

type ServiceBindingName = "USDA_API" | "UPC_LOOKUP" | "PURCHASE_AGENT";

/** Static asset fetcher exposed by the Cloudflare Worker runtime. */
export const getAssetsFetcher = (): typeof fetch | undefined => {
  const binding = cfEnv?.ASSETS;
  if (!binding) return undefined;
  // Wrap in an arrow — Fetcher["fetch"] isn't directly assignable to the
  // global fetch type. SAFETY: this is the single Cloudflare Fetcher/global
  // fetch overload boundary; both accept the same runtime Request inputs and
  // return a Promise<Response>.
  return ((input, init) =>
    binding.fetch(input as never, init as never)) as typeof fetch;
};

/**
 * Returns a fetch-compatible function backed by a service binding, or
 * undefined when not running on CF Workers. Binding fetch still requires
 * absolute URLs; the hostname is ignored for routing.
 */
export const getBindingFetcher = (
  name: ServiceBindingName,
): typeof fetch | undefined => {
  const binding =
    name === "USDA_API"
      ? cfEnv?.USDA_API
      : name === "UPC_LOOKUP"
        ? cfEnv?.UPC_LOOKUP
        : cfEnv?.PURCHASE_AGENT;
  if (!binding) return undefined;
  // Wrap in an arrow — Fetcher["fetch"] isn't directly assignable to the
  // global fetch type. SAFETY: this is the single Cloudflare Fetcher/global
  // fetch overload boundary; both accept the same runtime Request inputs and
  // return a Promise<Response>.
  return ((input, init) =>
    binding.fetch(input as never, init as never)) as typeof fetch;
};

export const getDatabaseFreshnessNamespace = () => cfEnv?.DB_FRESHNESS;

export const getWorkerVersionId = (): string =>
  cfEnv?.CF_VERSION_METADATA?.id ?? "local";

export const getAiResponseCacheNamespace = () => cfEnv?.AI_RESPONSE_CACHE;
