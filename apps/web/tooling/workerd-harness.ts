import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createTestHarness, type TestHarnessOptions } from "wrangler";
import { z } from "zod";

import { acquireHarnessLock } from "../../../scripts/lib/harness-lock.ts";

import { COUPLED_WORKER_BUILDS, ensureWorkerBuilds } from "./worker-builds";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Where one production queue's messages go in a test harness.
 *
 * - `real`: the built Worker's own consumer, with production settings except
 *   `max_batch_timeout: 0`, so a test never waits out a batching window.
 * - `dropped`: `local-offline-peers` acknowledges and discards every message.
 * - `unconsumed`: no consumer; messages stay queued for the harness's life.
 */
type QueueRoute = "real" | "dropped" | "unconsumed";

/**
 * Each profile routes every production queue consumer explicitly. The
 * built Worker's Durable Objects are real in every profile: they live in the
 * Worker itself.
 */
interface WorkerdProfileDefinition {
  queues: Record<
    "cubby-background" | "cubby-telemetry" | "cubby-purchase-agent",
    QueueRoute
  >;
  /** A local Google OAuth/Gmail provider (`tooling/local-google-provider.ts`). */
  googleProvider: boolean;
  /**
   * The purchase agent's model peer (`cubby-test-model`), the Worker's AI
   * Gateway peer (`cubby-test-gateway`), and `cubby-queue-producer`, which
   * dispatches agent events and connects simulated Mac browsers to the
   * `PurchaseImportDurableObject`. Deterministic unless a caller supplies
   * live peers.
   */
  purchaseAgentPeers: boolean;
  /**
   * Take the machine-wide harness lock and rebuild a stale Worker before
   * starting. A Playwright run already holds the lock from global setup, and
   * its workers pass straight through.
   */
  harnessLock: boolean;
}

export const WORKERD_PROFILES = {
  /** Browser E2E and the simulator lane: no background work runs. */
  offline: {
    queues: {
      "cubby-background": "dropped",
      "cubby-telemetry": "dropped",
      "cubby-purchase-agent": "unconsumed",
    },
    googleProvider: false,
    purchaseAgentPeers: false,
    harnessLock: false,
  },
  /** Gmail import journeys: the real background consumer runs mail search. */
  gmail: {
    queues: {
      "cubby-background": "real",
      "cubby-telemetry": "dropped",
      "cubby-purchase-agent": "unconsumed",
    },
    googleProvider: true,
    purchaseAgentPeers: false,
    harnessLock: false,
  },
  /** Provider acquisition and research use the deployed Workflow/queue handoffs. */
  "gmail-research": {
    queues: {
      "cubby-background": "real",
      "cubby-telemetry": "real",
      "cubby-purchase-agent": "real",
    },
    googleProvider: true,
    purchaseAgentPeers: true,
    harnessLock: true,
  },
  /** Actual Mac captures; the production coordinator uses scripted judgment. */
  "native-import": {
    queues: {
      "cubby-background": "dropped",
      "cubby-telemetry": "dropped",
      "cubby-purchase-agent": "real",
    },
    googleProvider: false,
    purchaseAgentPeers: true,
    harnessLock: true,
  },
  /**
   * The purchase agent against scripted (or live-eval) model peers: the real
   * agent queue and telemetry consumers run; background work stays queued so
   * no background task reaches a deterministic model peer.
   */
  "purchase-agent": {
    queues: {
      "cubby-background": "unconsumed",
      "cubby-telemetry": "real",
      "cubby-purchase-agent": "real",
    },
    googleProvider: false,
    purchaseAgentPeers: true,
    harnessLock: true,
  },
  /**
   * Coupled journeys: every consumer is real, including background image
   * processing, so pages with uploaded photos behave as deployed.
   */
  coupled: {
    queues: {
      "cubby-background": "real",
      "cubby-telemetry": "real",
      "cubby-purchase-agent": "real",
    },
    googleProvider: false,
    purchaseAgentPeers: true,
    harnessLock: true,
  },
} as const satisfies Record<string, WorkerdProfileDefinition>;

export type WorkerdProfile = keyof typeof WORKERD_PROFILES;

/** A model or gateway peer Worker that answers in place of the AI Gateway. */
export type WorkerdModelWorker = {
  main: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
};

export interface WorkerdHarnessOptions {
  profile: WorkerdProfile;
  databaseUrl: string;
  /** Omitted: storage is unreachable (port 9 refuses connections). */
  objectStorage?: {
    /** S3 endpoint the Worker writes through. */
    endpoint: string;
    /** Origin of public object URLs the Worker itself fetches back. */
    publicUrl: string;
  };
  /** Required by, and only by, a profile with `googleProvider`. */
  googleProviderUrl?: string;
  /** Live peers for a profile with `purchaseAgentPeers`; deterministic by default. */
  models?: { agent?: WorkerdModelWorker; gateway?: WorkerdModelWorker };
}

const consumerSchema = z.object({ queue: z.string() }).loose();
const compiledConfigSchema = z
  .object({
    main: z.string().optional(),
    compatibility_date: z.string(),
    ai: z.json().optional(),
    vectorize: z.json().optional(),
    hyperdrive: z.array(z.object({}).loose()).optional(),
    services: z
      .array(z.object({ binding: z.string(), service: z.string() }).loose())
      .optional(),
    assets: z.object({}).loose().optional(),
    queues: z
      .object({ consumers: z.array(consumerSchema).optional() })
      .loose()
      .optional(),
  })
  .loose();

const UNREACHABLE = "http://127.0.0.1:9";

/**
 * The current compiled Worker without production-only remote bindings (AI,
 * Vectorize), so starting it never needs Cloudflare credentials, keeping only
 * the queue consumers the profile routes `real`. Throws when the compiled
 * Worker's queue consumers and the profile's routes disagree, so a renamed
 * or added production consumer cannot silently stop running in tests.
 */
function compiledWebWorkerConfig(
  options: WorkerdHarnessOptions,
  profile: WorkerdProfileDefinition,
) {
  const source = path.join(webRoot, "dist/server/wrangler.json");
  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch (error) {
    throw new Error(
      "Build the web Cloudflare bundle before starting workerd (pnpm --dir apps/web build:cf)",
      { cause: error },
    );
  }
  const {
    ai: _ai,
    vectorize: _vectorize,
    ...config
  } = compiledConfigSchema.parse(JSON.parse(raw));

  const routes = new Map<string, QueueRoute>(Object.entries(profile.queues));
  const consumers = config.queues?.consumers ?? [];
  const consumed = new Set(consumers.map((consumer) => consumer.queue));
  const unrouted = [...consumed].filter((queue) => !routes.has(queue));
  const stale = [...routes.keys()].filter((queue) => !consumed.has(queue));
  if (unrouted.length > 0 || stale.length > 0)
    throw new Error(
      `The ${options.profile} workerd profile no longer matches the Worker's queue consumers (unrouted: ${unrouted.join(", ") || "none"}; missing: ${stale.join(", ") || "none"}). Route every consumer in WORKERD_PROFILES.`,
    );
  if (config.queues)
    config.queues.consumers = consumers
      .filter((consumer) => routes.get(consumer.queue) === "real")
      .map((consumer) => ({ ...consumer, max_batch_timeout: 0 }));
  config.hyperdrive = config.hyperdrive?.map((binding) => ({
    ...binding,
    localConnectionString: options.databaseUrl,
  }));
  // The inline config is rooted at apps/web, not dist/server.
  config.main = `dist/server/${config.main ?? "index.js"}`;
  if (config.assets) config.assets.directory = "dist/client";
  config.services = [
    ...(config.services ?? []).map((service) =>
      service.binding === "USDA_API"
        ? { ...service, service: "local-offline-peers" }
        : service,
    ),
    ...(profile.purchaseAgentPeers
      ? [
          // Harness-only bindings: the agent's model provider and the
          // Worker's own structured AI features answer from peers.
          {
            binding: "CUBBY_PURCHASE_AGENT_TEST_MODEL",
            service: "cubby-test-model",
          },
          { binding: "CUBBY_TEST_AI_GATEWAY", service: "cubby-test-gateway" },
        ]
      : []),
  ];

  return config;
}

/** The profile's peer Workers, sharing the web Worker's compatibility date. */
function peerWorkers(
  options: WorkerdHarnessOptions,
  profile: WorkerdProfileDefinition,
  compatibilityDate: string,
): TestHarnessOptions["workers"] {
  const consumersRoutedTo = (route: QueueRoute) =>
    Object.entries(profile.queues)
      .filter(([, to]) => to === route)
      .map(([queue]) => ({ queue, max_batch_timeout: 0 }));
  const model = options.models?.agent ?? {
    main: "tests/e2e/harness-services/purchase-agent-test-model.ts",
  };
  const gateway = options.models?.gateway ?? {
    main: "tests/e2e/harness-services/purchase-import-test-gateway.ts",
  };
  return [
    {
      config: {
        name: "local-offline-peers",
        main: "tooling/local-offline-peers.ts",
        compatibility_date: compatibilityDate,
        queues: { consumers: consumersRoutedTo("dropped") },
      },
    },
    ...(profile.purchaseAgentPeers
      ? [
          {
            config: {
              name: "cubby-queue-producer",
              main: "tests/e2e/harness-services/purchase-agent-queue-producer.ts",
              compatibility_date: compatibilityDate,
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
                  {
                    name: "PURCHASE_AGENT_RUN_CLIENT",
                    class_name: "PurchaseImportRunAgent",
                    script_name: "cubby",
                  },
                ],
              },
            },
          },
          {
            config: {
              name: "cubby-test-model",
              main: model.main,
              compatibility_date: compatibilityDate,
            },
            vars: model.vars,
            secrets: model.secrets,
          },
          {
            config: {
              name: "cubby-test-gateway",
              main: gateway.main,
              compatibility_date: compatibilityDate,
            },
            vars: gateway.vars,
            secrets: gateway.secrets,
          },
        ]
      : []),
  ];
}

/** The harness options for one profile: the built web Worker, then its peers. */
export function workerdHarnessOptions(
  options: WorkerdHarnessOptions,
): TestHarnessOptions {
  const profile: WorkerdProfileDefinition = WORKERD_PROFILES[options.profile];
  if (profile.googleProvider !== (options.googleProviderUrl !== undefined))
    throw new Error(
      `The ${options.profile} workerd profile ${profile.googleProvider ? "requires" : "does not take"} a Google provider`,
    );
  if (options.models && !profile.purchaseAgentPeers)
    throw new Error(
      `The ${options.profile} workerd profile has no model peers to replace`,
    );
  const config = compiledWebWorkerConfig(options, profile);
  const storage = options.objectStorage ?? {
    endpoint: UNREACHABLE,
    publicUrl: UNREACHABLE,
  };
  return {
    root: webRoot,
    workers: [
      // The web Worker is primary: `listen()` serves the app a browser drives.
      {
        config,
        vars: {
          ALLOW_SIGNUP: "true",
          INSECURE_AUTH_COOKIES: "true",
          E2E_AUTH_TEST_MODE: "true",
          DATABASE_URL: options.databaseUrl,
          R2_ENDPOINT: storage.endpoint,
          R2_PUBLIC_URL: storage.publicUrl,
          R2_BUCKET_NAME: "e2e-bucket",
          R2_KEY_PREFIX: "e2e",
          R2_ACCESS_KEY_ID: "dummy",
          R2_SECRET_ACCESS_KEY: "dummy",
          USDA_API_URL: "http://127.0.0.1:9/",
          UPC_UPSTREAM_DISABLED: "true",
          // Keyless and deterministic like CI; a model peer, when present,
          // takes precedence over the Gateway transport anyway.
          AI_GATEWAY_API_KEY: "",
          ...(options.googleProviderUrl && {
            E2E_GOOGLE_PROVIDER_URL: options.googleProviderUrl,
            GOOGLE_CLIENT_ID: "synthetic-google-client",
            GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
          }),
        },
        // Test-side signers (native lanes) set the same process secret.
        secrets: {
          BETTER_AUTH_SECRET:
            process.env.BETTER_AUTH_SECRET || "e2e-test-secret",
        },
      },
      ...peerWorkers(options, profile, config.compatibility_date),
    ],
  };
}

const databaseEnvironmentKeys = [
  // Test-side fixtures and helpers connect through this.
  "E2E_DATABASE_URL",
  // The Worker's Hyperdrive bindings resolve through these in workerd.
  "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
  "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
] as const;

function installDatabaseEnvironment(databaseUrl: string) {
  const previous = databaseEnvironmentKeys.map(
    (key) => [key, process.env[key]] as const,
  );
  for (const key of databaseEnvironmentKeys) process.env[key] = databaseUrl;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

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

type Closer = () => void | Promise<void>;

/**
 * Resources closed newest first. `close()` runs every closer even when one
 * fails, reports all failures together, and is idempotent. `guard` runs an
 * acquisition and, when it throws, closes what it acquired so far; the
 * acquisition error comes first, a cleanup failure after it.
 */
export function cleanupStack() {
  const closers: Array<{ label: string; close: Closer }> = [];
  let closing: Promise<void> | undefined;
  const closeAll = async () => {
    const failures: Error[] = [];
    for (const { label, close } of [...closers].reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(new Error(`Failed to close ${label}`, { cause: error }));
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "Test runtime cleanup failed");
  };
  const close = () => (closing ??= closeAll());
  return {
    push(label: string, closer: Closer) {
      if (closing) throw new Error(`Cannot hold ${label}: already closed`);
      closers.push({ label, close: closer });
    },
    close,
    async guard<T>(acquire: () => Promise<T>): Promise<T> {
      try {
        return await acquire();
      } catch (error) {
        try {
          await close();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Test runtime setup failed and its cleanup failed",
            { cause: cleanupError },
          );
        }
        throw error;
      }
    },
  };
}

/**
 * Start and listen on the built Cubby Worker under one profile, pointed at
 * `databaseUrl`. The returned harness's `close()` stops workerd, restores the
 * database environment, and releases the harness lock, in that order; a
 * failed start does the same before rethrowing. The caller owns the database
 * and object storage.
 */
export async function startWorkerdHarness(options: WorkerdHarnessOptions) {
  const cleanup = cleanupStack();
  return cleanup.guard(async () => {
    if (WORKERD_PROFILES[options.profile].harnessLock)
      cleanup.push("harness lock", await holdWorkerdHarness());
    const harnessOptions = workerdHarnessOptions(options);
    cleanup.push(
      "database environment",
      installDatabaseEnvironment(options.databaseUrl),
    );
    const harness = createTestHarness(harnessOptions);
    const closeWorkerd = harness.close.bind(harness);
    cleanup.push("workerd", closeWorkerd);
    try {
      await harness.listen();
    } catch (error) {
      // The timeline names which Worker failed to start.
      harness.debug();
      throw error;
    }
    return Object.assign(harness, { close: cleanup.close });
  });
}

export type WorkerdHarness = Awaited<ReturnType<typeof startWorkerdHarness>>;
