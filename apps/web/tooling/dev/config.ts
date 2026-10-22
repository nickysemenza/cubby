import { bindings, defineWorker, triggers, type WorkerConfig } from "cf/config";
import type { DevProfile } from "../dev-services/dev-profile.ts";

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
    },
    triggers: [
      triggers.queue({
        name: `${name}-background`,
        maxBatchSize: 1,
        maxBatchTimeout: 0,
        maxConcurrency: 1,
        maxRetries: 0,
      }),
      triggers.queue({
        name: `${name}-telemetry`,
        maxBatchSize: 100,
        maxBatchTimeout: 5,
        maxConcurrency: 1,
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
      TELEMETRY_QUEUE: bindings.queue({ name: `${name}-telemetry` }),

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
