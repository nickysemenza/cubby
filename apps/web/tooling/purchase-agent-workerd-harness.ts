/* eslint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-object-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- The harness adapts generated Wrangler JSON whose binding dictionaries have no source-level owner type, and forwards queue events, browser outcomes, and peer fixtures unchanged as JSON. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestHarness, type TestHarness } from "wrangler";
import { z } from "zod";

import type { ScriptStep } from "./purchase-agent-script";

import { acquireHarnessLock } from "../../../scripts/lib/harness-lock.ts";

import { COUPLED_WORKER_BUILDS, ensureWorkerBuilds } from "./worker-builds";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
function workerdWebConfig(databaseUrl: string, backgroundQueue: boolean) {
  const config = JSON.parse(
    readFileSync(path.join(webRoot, "dist/server/wrangler.json"), "utf8"),
  ) as Record<string, unknown> & {
    main?: string;
    hyperdrive?: Array<Record<string, unknown>>;
    services?: Array<Record<string, unknown>>;
  };
  // Keep the current compiled Worker but remove production-only remote
  // bindings: the harness supplies its isolated database and a deterministic
  // model, so starting it must never require Cloudflare credentials.
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
      .filter(
        (consumer) =>
          consumer.queue === "cubby-telemetry" ||
          consumer.queue === "cubby-purchase-agent" ||
          (backgroundQueue && consumer.queue === "cubby-background"),
      )
      .map((consumer) => ({ ...consumer, max_batch_timeout: 0 }));
  // `configPath` resolves this relative to dist/server; the inline config is
  // rooted at apps/web, so retain the compiled entrypoint explicitly.
  config.main = `dist/server/${config.main ?? "index.js"}`;
  const assets = config.assets as Record<string, unknown> | undefined;
  if (assets) assets.directory = "dist/client";
  config.services = [
    ...(config.services ?? []).map((service) =>
      service.binding === "USDA_API"
        ? { ...service, service: "local-offline-peers" }
        : service,
    ),
    // Harness-only: the purchase agent's model provider and the Worker's own
    // structured AI features (extraction, the required import audit) answer
    // from deterministic peers.
    { binding: "CUBBY_PURCHASE_AGENT_TEST_MODEL", service: "cubby-test-model" },
    { binding: "CUBBY_TEST_AI_GATEWAY", service: "cubby-test-gateway" },
  ];
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

const DETERMINISTIC_GATEWAY: WorkerdModelWorker = {
  main: "tests/e2e/harness-services/purchase-import-test-gateway.ts",
};

/**
 * Queue for the machine-wide harness lock, then make every coupled Worker
 * build current (rebuilding a stale one locally). A suite calls this in
 * `beforeAll` with a long timeout and releases in `afterAll`, so the wait and
 * any rebuild never count against a test's timeout.
 */
export async function holdWorkerdHarness(): Promise<() => void> {
  const release = await acquireHarnessLock("coupled Workers harness");
  try {
    ensureWorkerBuilds(COUPLED_WORKER_BUILDS);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

/** Long enough to queue behind another suite and rebuild every Worker. */
export const HOLD_WORKERD_HARNESS_TIMEOUT_MS = 30 * 60_000;

/**
 * What browser runs add to the scripted scenarios: real object storage
 * (`createE2EObjectStorage`) for pages with images and uploaded photos, and
 * the background queue consumer that runs image processing. Scripted
 * scenarios keep neither, so no background task reaches a deterministic
 * model peer.
 */
type WorkerdHarnessServices = {
  objectStorage?: {
    /** S3 endpoint the Worker writes through. */
    endpoint: string;
    /** Origin of public object URLs the Worker itself fetches back. */
    publicUrl: string;
  };
  backgroundQueue?: boolean;
};

/**
 * The purchase-agent workerd harness: the built `cubby` Worker, which hosts
 * the agent and consumes its queue. Its model worker is `cubby-test-model`
 * (the agent's provider) and its gateway worker is `cubby-test-gateway` (the
 * Worker's structured features): deterministic fakes by default, or Gateway
 * proxies for live evals and journeys.
 */
export async function createWorkerdHarness(
  databaseUrl: string,
  modelWorker: WorkerdModelWorker = DETERMINISTIC_MODEL,
  gatewayWorker: WorkerdModelWorker = DETERMINISTIC_GATEWAY,
  services: WorkerdHarnessServices = {},
) {
  const release = await holdWorkerdHarness();
  let harness: ReturnType<typeof createTestHarness>;
  try {
    harness = startHarness(databaseUrl, modelWorker, gatewayWorker, services);
  } catch (error) {
    release();
    throw error;
  }
  const close = harness.close.bind(harness);
  return Object.assign(harness, {
    close: async () => {
      try {
        await close();
      } finally {
        release();
      }
    },
  });
}

function startHarness(
  databaseUrl: string,
  modelWorker: WorkerdModelWorker,
  gatewayWorker: WorkerdModelWorker,
  services: WorkerdHarnessServices,
) {
  // Port 9 refuses connections: storage stays unreachable unless supplied.
  const storage = services.objectStorage ?? {
    endpoint: "http://127.0.0.1:9",
    publicUrl: "http://127.0.0.1:9",
  };
  return createTestHarness({
    root: webRoot,
    workers: [
      // The web Worker is primary: `listen()` serves the app a browser drives.
      {
        config: workerdWebConfig(
          databaseUrl,
          services.backgroundQueue ?? false,
        ),
        vars: {
          ALLOW_SIGNUP: "true",
          INSECURE_AUTH_COOKIES: "true",
          E2E_AUTH_TEST_MODE: "true",
          DATABASE_URL: databaseUrl,
          R2_ENDPOINT: storage.endpoint,
          R2_PUBLIC_URL: storage.publicUrl,
          R2_BUCKET_NAME: "e2e-bucket",
          R2_KEY_PREFIX: "e2e",
          R2_ACCESS_KEY_ID: "dummy",
          R2_SECRET_ACCESS_KEY: "dummy",
          USDA_API_URL: "http://127.0.0.1:9/",
          UPC_UPSTREAM_DISABLED: "true",
        },
        secrets: { BETTER_AUTH_SECRET: "workerd-test-secret" },
      },
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
          name: "cubby-test-gateway",
          main: gatewayWorker.main,
          compatibility_date: "2026-09-19",
        },
        vars: gatewayWorker.vars,
        secrets: gatewayWorker.secrets,
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

/** One scripted purchase-agent scenario: the coordinator's steps and the gateway's outputs. */
export type ScriptedScenario = {
  steps: ScriptStep[];
  extractions?: Array<{ match: string; output: unknown }>;
  audit?: unknown;
};

type JsonPost = {
  method: "POST";
  headers: Record<string, string>;
  body: string;
};
type Sender = (
  path: string,
  init: JsonPost,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Drive a listening purchase-agent harness: load a scenario into its
 * deterministic peers, deliver queue events, and read what the agent did.
 */
export function scenarioControls(harness: TestHarness) {
  const model = harness.getWorker("cubby-test-model");
  const gateway = harness.getWorker("cubby-test-gateway");
  const queue = harness.getWorker("cubby-queue-producer");
  const post = async (send: Sender, path: string, body: object) => {
    const response = await send(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`${path} ${response.status}: ${await response.text()}`);
  };
  const toModel: Sender = (path, init) => model.fetch(path, init);
  const toGateway: Sender = (path, init) => gateway.fetch(path, init);
  const toQueue: Sender = (path, init) =>
    queue.fetch(new URL(path, "https://queue.test"), init);
  const readJson = async <T>(
    schema: z.ZodType<T>,
    send: () => Promise<{ json(): Promise<unknown> }>,
  ): Promise<T> => schema.parse(await (await send()).json());
  return {
    /** Replace the scripted model's steps and the gateway's outputs. */
    configure: async (scenario: ScriptedScenario) => {
      await post(toModel, "https://model.test/configure", {
        steps: scenario.steps,
      });
      const gatewayFixture: { extractions: unknown[]; audit?: unknown } = {
        extractions: scenario.extractions ?? [],
      };
      if (scenario.audit) gatewayFixture.audit = scenario.audit;
      await post(toGateway, "https://gateway.test/configure", gatewayFixture);
    },
    /** Let the model answer past a `{ gate }` step. */
    release: (gate: string) =>
      post(toModel, "https://model.test/release", { gate }),
    /** Deliver one purchase-agent queue event, as the web Worker would. */
    dispatch: (event: Record<string, unknown>) =>
      post(toQueue, "/dispatch", event),
    /** Connect a simulated Mac browser that answers commands by URL. */
    connectBrowser: (input: {
      vendorAccountId: string;
      ledgerPartyId: string;
      userId: string;
      outcomes?: Record<string, unknown>;
      delayMs?: number;
    }) => post(toQueue, "/browser-connect", input),
    violations: async () =>
      readJson(z.array(z.string()), () =>
        model.fetch("https://model.test/violations"),
      ),
    /** Each step the scripted model emitted: what the agent actually executed. */
    emitted: async () =>
      readJson(z.array(z.string()), () =>
        model.fetch("https://model.test/emitted"),
      ),
    gatewayCalls: async () =>
      readJson(
        z.array(
          z.object({ feature: z.string(), matched: z.string().nullable() }),
        ),
        () => gateway.fetch("https://gateway.test/calls"),
      ),
  };
}

export type ScenarioControls = ReturnType<typeof scenarioControls>;
