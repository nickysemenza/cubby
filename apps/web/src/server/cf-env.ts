import { AsyncLocalStorage } from "node:async_hooks";

import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";

import type { VectorizeIndexBinding } from "./generic/embedding/service/semantic/vector-store";
import type { TelemetryQueueProducer } from "./observability/telemetry-queue-types";
import type { BackgroundQueueProducer } from "./workflows/background-queue-types";

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
  origin?: string;
}

/**
 * Execution context belongs to one request. A module-level one would be overwritten by
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

/**
 * Best-effort work the response does not need: inside a Worker request it
 * runs past the response; elsewhere nothing keeps an un-awaited promise
 * alive, so the caller waits. `task` must catch and log its own failure.
 */
export const afterResponse = async (task: Promise<void>): Promise<void> => {
  const execution = getExecutionCtx();
  if (execution) execution.waitUntil(task);
  else await task;
};

const environmentStore = new AsyncLocalStorage<Env>();
// Node test adapters can install a fallback. Production events and DO work use
// withCfEnv so concurrent invocations and binding updates cannot replace it.
let fallbackEnv: Env | undefined;
const currentEnv = (): Env | undefined =>
  environmentStore.getStore() ?? fallbackEnv;

export const withCfEnv = <T>(env: Env, run: () => Promise<T>): Promise<T> =>
  environmentStore.run(env, run);

/** Authentication reads binding values before constructing its cached instance. */
export const getAuthBindings = () => currentEnv();

export const setCfEnv = (env?: Env): void => {
  fallbackEnv = env;
};

/** True after the request has entered the Cloudflare Worker adapter. */
export const isCloudflareRuntime = (): boolean => currentEnv() !== undefined;

/**
 * The background queue producer (`env.BACKGROUND_QUEUE`) on local or deployed
 * Workers, or undefined outside the Worker adapter. The binding
 * is declared in cloudflare.config.ts; this accessor narrows it to the producer
 * surface shared by production and tests.
 */
export const getBackgroundQueue = (): BackgroundQueueProducer | undefined => {
  // SAFETY: native configuration infers Env bindings structurally;
  // this adapter narrows that generated queue binding to Cubby's owned port.
  return currentEnv()?.BACKGROUND_QUEUE as BackgroundQueueProducer | undefined;
};

/** The low-priority telemetry queue when configured in the Worker environment. */
export const getTelemetryQueue = (): TelemetryQueueProducer | undefined => {
  // SAFETY: native configuration infers Env bindings structurally;
  // this adapter narrows that generated queue binding to Cubby's owned port.
  return currentEnv()?.TELEMETRY_QUEUE as TelemetryQueueProducer | undefined;
};

/** Worker secrets are not part of the generated Wrangler Env type. */
export const getGmailOAuthCredentials = () => {
  const cfEnv = currentEnv();
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
  const cfEnv = currentEnv();
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
  currentEnv()?.CALENDAR_FEED;

/** The purchase agent's per-Run coordinators (`server/domains/purchase-import/operations/agent-host`). */
export const getPurchaseImportRunAgentNamespace = () =>
  currentEnv()?.PURCHASE_IMPORT_RUN;

/** USDA release Durable Objects and the active release name (`server/domains/usda-release`). */
export const getUsdaReleaseEnv = ():
  | Pick<Env, "USDA_RELEASE" | "USDA_ACTIVE_RELEASE">
  | undefined => currentEnv();

/** Connected native image workers share this transport; job authority stays in Postgres. */
export const getImageProcessingNamespace = () => currentEnv()?.IMAGE_PROCESSING;

/**
 * The optional Workers AI binding (`env.AI`) from the Worker environment. The
 * transport shim in `~/server/ai/gateway` runs Workers AI models on it
 * directly and reaches every other provider through `getAiGateway`.
 */
export const getAi = () => currentEnv()?.AI;

/** The binding's Universal endpoint for Cubby's gateway (`env.AI.gateway("cubby")`). */
export const getAiGateway = (gatewayId: string = CUBBY_AI_GATEWAY_ID) =>
  currentEnv()?.AI?.gateway(gatewayId);

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
    currentEnv() as
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
  return currentEnv()?.VECTORIZE as VectorizeIndexBinding | undefined;
};

export const getDatabaseFreshnessNamespace = () => currentEnv()?.DB_FRESHNESS;

/** Invocation work never competes for the interactive Hyperdrive origin pool. */
export const getBackgroundDatabaseConnectionString = () =>
  currentEnv()?.HYPERDRIVE_BACKGROUND?.connectionString;

export const getAiResponseCacheNamespace = () =>
  currentEnv()?.AI_RESPONSE_CACHE;
export const getChatGptPlanNamespace = () => currentEnv()?.CHATGPT_PLAN;

export const getAiGatewayEgress = (gatewayId: string) =>
  currentEnv()?.AI_GATEWAY_EGRESS?.getByName(gatewayId);

export const getAppOrigin = () => currentEnv()?.APP_ORIGIN;

type SourceReleaseEnv = Partial<
  Pick<Env, "CUBBY_SOURCE_COMMIT" | "CUBBY_SOURCE_BRANCH" | "CUBBY_SOURCE_DATE">
>;

/**
 * The deployed source, read from Worker values set at deploy time
 * (`.github/actions/deploy-worker`) or by local runtimes, never compiled into
 * the bundle, so one build serves every commit with identical content. Unset
 * outside a configured Worker: `unknown`, and no date.
 */
export const getSourceRelease = (
  env: SourceReleaseEnv | undefined = currentEnv(),
) => {
  const commit = env?.CUBBY_SOURCE_COMMIT || "unknown";
  return {
    commit,
    branch: env?.CUBBY_SOURCE_BRANCH || "unknown",
    date: env?.CUBBY_SOURCE_DATE || null,
    // Must equal the Sentry plugin's release name (vite.config.ts).
    sentryRelease: `cubby@${commit}`,
  };
};

/** Host-only access for constructing the narrowed purchase dispatch services. */
export const getPurchaseDispatchHostEnv = () => currentEnv();
