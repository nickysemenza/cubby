// Access to the CF Workers env (service bindings) outside the fetch handler.
//
// Module-level storage is safe here — unlike the per-request pg.Pool in
// db.ts, `env` is the same object for every request in an isolate. On the
// dev server (plain Node via vite) setCfEnv is never called, so accessors
// return undefined and callers fall back to public URLs + global fetch.

import { AsyncLocalStorage } from "node:async_hooks";

import type { BackgroundQueueProducer } from "./background-queue-types";
import type { TelemetryQueueProducer } from "./telemetry-queue-types";

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
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
): Promise<T> => executionCtxStore.run(ctx, fn);

/** Undefined outside a CF request (queue/cron invocations, the Node dev server). */
export const getExecutionCtx = (): WaitUntilContext | undefined =>
  executionCtxStore.getStore();

export interface ProblemCountsCacheAdapter {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

let cfEnv: Env | undefined;

export const setCfEnv = (env?: Env): void => {
  cfEnv = env;
};

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

/** KV-backed derived Problem-count snapshot, absent in plain Node dev/tests. */
export const getProblemCountsCache = ():
  | ProblemCountsCacheAdapter
  | undefined => {
  const binding = cfEnv?.PROBLEM_COUNTS_KV;
  if (!binding) return undefined;
  return {
    get: (key) => binding.get(key),
    put: (key, value) => binding.put(key, value),
  };
};

// Cubby's Cloudflare account + AI Gateway identifiers. Single source of truth
// for the gateway binding (below) and the gateway-REST base URL built in
// `~/server/clients/anthropic`.
export const CF_ACCOUNT_ID = "9f10f078d35d86c78dedece2300a6b88";
export const CF_AIG_GATEWAY_ID = "cubby";

/**
 * The AI Gateway binding (`env.AI.gateway("cubby")`) on CF Workers, or undefined
 * on the dev Node server (where setCfEnv is never called). Used by the Anthropic
 * /OpenAI clients to authenticate via Worker identity in prod; dev falls back to
 * gateway-REST with AI_GATEWAY_API_KEY.
 */
export const getAiGateway = () => cfEnv?.AI?.gateway(CF_AIG_GATEWAY_ID);

type ServiceBindingName = "USDA_API" | "UPC_LOOKUP";

/**
 * Returns a fetch-compatible function backed by a service binding, or
 * undefined when not running on CF Workers. Binding fetch still requires
 * absolute URLs; the hostname is ignored for routing.
 */
export const getBindingFetcher = (
  name: ServiceBindingName,
): typeof fetch | undefined => {
  const binding = cfEnv?.[name];
  if (!binding) return undefined;
  // Wrap in an arrow — Fetcher["fetch"] isn't directly assignable to the
  // global fetch type. SAFETY: this is the single Cloudflare Fetcher/global
  // fetch overload boundary; both accept the same runtime Request inputs and
  // return a Promise<Response>.
  return ((input, init) =>
    binding.fetch(input as never, init as never)) as typeof fetch;
};
