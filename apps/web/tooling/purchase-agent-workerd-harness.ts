/* eslint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- The harness adapts generated Wrangler JSON whose binding dictionaries have no source-level owner type. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const agentConfigPath = path.join(
  webRoot,
  "../purchase-agent/dist/purchase_agent/wrangler.json",
);

function workerdAgentConfig() {
  const config = JSON.parse(readFileSync(agentConfigPath, "utf8")) as {
    ai?: Record<string, unknown>;
    services?: Array<Record<string, unknown>>;
    queues?: { consumers?: Array<Record<string, unknown>> };
  };
  // The harness supplies a deterministic model through a local service. Keep
  // the production Workers AI binding out of this process so CI never tries to
  // establish a remote Cloudflare proxy session.
  delete config.ai;
  return {
    ...config,
    main: "../purchase-agent/dist/purchase_agent/index.js",
    queues: {
      ...config.queues,
      consumers: config.queues?.consumers?.map((consumer) => ({
        ...consumer,
        max_batch_timeout: 0,
      })),
    },
    services: [
      ...(config.services ?? []).map((service) =>
        service.binding === "CUBBY_PURCHASE_SERVICE"
          ? { ...service, service: "cubby" }
          : service,
      ),
      {
        binding: "CUBBY_PURCHASE_AGENT_TEST_MODEL",
        service: "cubby-test-model",
      },
    ],
  };
}

function workerdWebConfig(databaseUrl: string) {
  const config = JSON.parse(
    readFileSync(path.join(webRoot, "dist/server/wrangler.json"), "utf8"),
  ) as Record<string, unknown> & {
    main?: string;
    hyperdrive?: Array<Record<string, unknown>>;
    services?: Array<Record<string, unknown>>;
  };
  // Keep the current compiled Worker but remove production-only remote
  // bindings; the harness supplies its isolated database and owns agent queue
  // delivery, so starting it must never require Cloudflare credentials.
  delete config.ai;
  delete config.vectorize;
  config.hyperdrive = config.hyperdrive?.map((binding) => ({
    ...binding,
    localConnectionString: databaseUrl,
  }));
  const queues = config.queues as Record<string, unknown> | undefined;
  if (queues)
    queues.consumers = (
      (queues.consumers ?? []) as Array<Record<string, unknown>>
    )
      .filter((consumer) => consumer.queue === "cubby-telemetry")
      .map((consumer) => ({ ...consumer, max_batch_timeout: 0 }));
  // `configPath` resolves this relative to dist/server; the inline config is
  // rooted at apps/web, so retain the compiled entrypoint explicitly.
  config.main = `dist/server/${config.main ?? "index.js"}`;
  const assets = config.assets as Record<string, unknown> | undefined;
  if (assets) assets.directory = "dist/client";
  config.services = (config.services ?? []).map((service) => {
    const replacements: Record<string, string> = {
      USDA_API: "local-offline-peers",
      UPC_LOOKUP: "local-offline-peers",
      PURCHASE_AGENT: "purchase-agent",
    };
    const binding = String(service.binding ?? "");
    return replacements[binding]
      ? { ...service, service: replacements[binding] }
      : service;
  });
  return config;
}

/** The model peer the agent calls instead of the Gateway binding. */
export type WorkerdModelWorker = {
  main: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
};

const DETERMINISTIC_MODEL: WorkerdModelWorker = {
  main: "tests/e2e/harness-services/purchase-agent-test-model.ts",
};

/**
 * The coupled web + purchase-agent workerd harness. Its model worker is
 * `cubby-test-model`: the deterministic fake by default, or a Gateway proxy
 * for a live model eval.
 */
export function createWorkerdHarness(
  databaseUrl: string,
  modelWorker: WorkerdModelWorker = DETERMINISTIC_MODEL,
) {
  return createTestHarness({
    root: webRoot,
    workers: [
      {
        config: {
          name: "cubby-queue-producer",
          main: "tests/e2e/harness-services/purchase-agent-queue-producer.ts",
          compatibility_date: "2026-09-19",
          queues: {
            producers: [
              {
                binding: "PURCHASE_AGENT_QUEUE",
                queue: "cubby-purchase-agent",
              },
            ],
          },
          durable_objects: {
            bindings: [
              {
                name: "PURCHASE_IMPORT_CLIENT",
                class_name: "PurchaseImportDurableObject",
                script_name: "cubby",
              },
            ],
          },
        },
      },
      {
        config: workerdWebConfig(databaseUrl),
        vars: {
          ALLOW_SIGNUP: "true",
          INSECURE_AUTH_COOKIES: "true",
          E2E_AUTH_TEST_MODE: "true",
          DATABASE_URL: databaseUrl,
          R2_ENDPOINT: "http://127.0.0.1:9",
          R2_PUBLIC_URL: "http://127.0.0.1:9",
          R2_BUCKET_NAME: "e2e-bucket",
          R2_KEY_PREFIX: "e2e",
          R2_ACCESS_KEY_ID: "dummy",
          R2_SECRET_ACCESS_KEY: "dummy",
          USDA_API_URL: "http://127.0.0.1:9/",
        },
        secrets: { BETTER_AUTH_SECRET: "workerd-test-secret" },
      },
      {
        config: workerdAgentConfig(),
        // "test" disables Sentry in both the agent Durable Object wrapper and
        // the queue consumer, so the harness never reports to sentry.io.
        vars: { SENTRY_ENVIRONMENT: "test" },
      },
      {
        config: {
          name: "cubby-test-model",
          main: modelWorker.main,
          compatibility_date: "2026-09-19",
        },
        vars: modelWorker.vars,
        secrets: modelWorker.secrets,
      },
      {
        config: {
          name: "local-offline-peers",
          main: "tooling/local-offline-peers.ts",
          compatibility_date: "2026-09-19",
        },
      },
    ],
  });
}
