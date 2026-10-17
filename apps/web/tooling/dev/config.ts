import {
  bindings,
  defineWorker,
  exports,
  triggers,
  type WorkerConfig,
} from "cf/config";
import type { DevProfile } from "../../../../scripts/lib/dev-profile.ts";

/** Reuse binding declarations, with checkout-local targets and no production triggers. */
export function localWorker(production: WorkerConfig, profile: DevProfile) {
  const name = `cubby-dev-${profile.id}`;
  const env = { ...production.env };
  for (const key of ["AI", "VECTORIZE", "HYPERDRIVE", "HYPERDRIVE_CACHED"])
    delete env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value && value.type === "secret") delete env[key];
    if (value && value.type === "durable-object")
      env[key] = bindings.durableObject({ ...value, worker: name });
  }
  return defineWorker({
    ...production,
    name,
    entrypoint: "tooling/dev/worker.ts",
    domains: [],
    placement: undefined,
    observability: { enabled: true },
    exports: {
      ...production.exports,
      AiRefreshWorkflow: exports.workflow({ name: `${name}-ai-refresh` }),
      SearchIndexRepairWorkflow: exports.workflow({
        name: `${name}-search-index-repair`,
      }),
      MailDiscoveryWorkflow: exports.workflow({
        name: `${name}-mail-discovery`,
      }),
    },
    triggers: [
      triggers.queue({
        name: `${name}-image-cloud`,
        maxBatchSize: 1,
        maxBatchTimeout: 0,
        maxConcurrency: 4,
        maxRetries: 3,
      }),
      triggers.queue({
        name: `${name}-background`,
        maxBatchSize: 1,
        maxBatchTimeout: 0,
        maxConcurrency: 1,
        maxRetries: 3,
      }),
      triggers.queue({
        name: `${name}-telemetry`,
        maxBatchSize: 100,
        maxBatchTimeout: 5,
        maxConcurrency: 1,
        maxRetries: 3,
      }),
      triggers.queue({
        name: `${name}-purchase`,
        maxBatchSize: 10,
        maxBatchTimeout: 0,
        maxRetries: 3,
      }),
    ],
    env: {
      ...env,
      ...Object.fromEntries(
        Object.entries(profile.vars).map(([key, value]) => [
          key,
          bindings.text(value),
        ]),
      ),
      HYPERDRIVE: bindings.hyperdrive({
        id: "00000000000000000000000000000000",
        dev: { connectionString: profile.databaseUrl },
      }),
      HYPERDRIVE_CACHED: bindings.hyperdrive({
        id: "00000000000000000000000000000000",
        dev: { connectionString: profile.databaseUrl },
      }),
      LOCAL_DEV_STORAGE: bindings.r2({ name: `${name}-storage` }),
      USDA_RELEASES: bindings.r2({ name: `${name}-usda-releases` }),
      BACKGROUND_QUEUE: bindings.queue({ name: `${name}-background` }),
      IMAGE_CLOUD_QUEUE: bindings.queue({ name: `${name}-image-cloud` }),
      TELEMETRY_QUEUE: bindings.queue({ name: `${name}-telemetry` }),
      PURCHASE_AGENT_QUEUE: bindings.queue({ name: `${name}-purchase` }),
      AI_REFRESH: bindings.workflow({
        name: `${name}-ai-refresh`,
        worker: name,
        exportName: "AiRefreshWorkflow",
      }),
      SEARCH_INDEX_REPAIR: bindings.workflow({
        name: `${name}-search-index-repair`,
        worker: name,
        exportName: "SearchIndexRepairWorkflow",
      }),
      MAIL_DISCOVERY: bindings.workflow({
        name: `${name}-mail-discovery`,
        worker: name,
        exportName: "MailDiscoveryWorkflow",
      }),
      ...(profile.integration && {
        AI: bindings.ai({ dev: { remote: true } }),
        VECTORIZE: bindings.vectorize({
          name: profile.integration.vectorizeIndex,
          dev: { remote: true },
        }),
      }),
    },
  });
}
