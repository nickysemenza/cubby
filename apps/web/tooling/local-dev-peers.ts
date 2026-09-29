import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { Plugin } from "vite";
import type { WorkerConfig } from "@cloudflare/vite-plugin";
import type { Unstable_RawConfig } from "wrangler";
import { getPlatformProxy } from "wrangler";
import type { DevProfile } from "../../../scripts/lib/dev-profile.ts";

type ConfigCustomizer = (config: WorkerConfig) => void;
const purchaseCustomizers = new Map<string, ConfigCustomizer>();

/** Must precede cloudflare() so Flue can register its real local agent DO. */
export async function createLocalDevPeerPlugins(
  profile: DevProfile,
): Promise<Plugin[]> {
  if (profile.profile === "offline") return [];
  const purchaseRoot = path.join(profile.repoRoot, "apps/purchase-agent");
  const { flue, flueWorkerConfig } = await import(
    pathToFileURL(path.join(purchaseRoot, "tooling/local-dev-flue.ts")).href
  );
  const plugins: Plugin[] = flue({
    target: "cloudflare",
    app: path.join(purchaseRoot, "src/app.ts"),
    cloudflare: path.join(purchaseRoot, "src/cloudflare.ts"),
    agents: path.join(purchaseRoot, "src/purchase-import-run.ts"),
    providers: [],
  });
  purchaseCustomizers.set(profile.id, flueWorkerConfig());
  return plugins;
}

export async function createLocalDevPeers(profile: DevProfile) {
  const configRoot = path.join(profile.stateDir, "peers");
  await mkdir(configRoot, { recursive: true });
  const prefix = `cubby-dev-${profile.id}`;
  const services = {
    USDA_API: `${prefix}-usda`,
    UPC_LOOKUP: `${prefix}-upc`,
    PURCHASE_AGENT: `${prefix}-purchase`,
  };
  const queueName = `${prefix}-purchase`;
  const common = {
    compatibility_date: "2026-09-19",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: false },
  };
  const purchaseConfig: Unstable_RawConfig = {
    ...common,
    name: services.PURCHASE_AGENT,
    main: path.join(profile.webRoot, "tooling/local-dev-offline-purchase.ts"),
    vars: { ...profile.vars, SENTRY_ENVIRONMENT: "test" },
    queues: { consumers: [{ queue: queueName, max_retries: 3 }] },
  };
  if (profile.profile === "integrations") {
    delete purchaseConfig.main;
    purchaseConfig.ai = { binding: "AI", remote: true };
    purchaseConfig.services = [
      {
        binding: "CUBBY_PURCHASE_SERVICE",
        service: `cubby-dev-${profile.id}`,
        entrypoint: "PurchaseImportService",
      },
    ];
    purchaseConfig.migrations = [
      { tag: "v1", new_sqlite_classes: ["FluePurchaseImportRunAgent"] },
    ];
  }
  const configs = [
    {
      ...common,
      name: services.USDA_API,
      main: path.join(profile.repoRoot, "apps/usda-api/src/local-dev.ts"),
      vars: { SENTRY_ENVIRONMENT: "test" },
      d1_databases: [
        {
          binding: "DB",
          database_name: `${prefix}-usda`,
          database_id: `${profile.id}-usda`,
        },
      ],
      r2_buckets: [{ binding: "USDA_BUNDLES", bucket_name: `${prefix}-usda` }],
    },
    {
      ...common,
      name: services.UPC_LOOKUP,
      main: path.join(profile.repoRoot, "apps/upc-lookup/src/local-dev.ts"),
      vars: {
        API_KEY: profile.vars.UPC_LOOKUP_API_KEY ?? "cubby-local",
        LOCAL_OFFLINE: "true",
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: `${prefix}-upc`,
          database_id: `${profile.id}-upc`,
        },
      ],
      r2_buckets: [{ binding: "IMAGES", bucket_name: `${prefix}-upc` }],
    },
    purchaseConfig,
  ];
  const auxiliaryWorkers: Array<{
    configPath: string;
    config?: ConfigCustomizer;
    devOnly: true;
  }> = [];
  for (const [index, config] of configs.entries()) {
    const configPath = path.join(configRoot, `${config.name}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    const customizer =
      index === 2 && profile.profile === "integrations"
        ? purchaseCustomizers.get(profile.id)
        : undefined;
    const auxiliary: (typeof auxiliaryWorkers)[number] = {
      configPath,
      devOnly: true,
    };
    if (customizer) auxiliary.config = customizer;
    auxiliaryWorkers.push(auxiliary);
  }
  return { auxiliaryWorkers, services, queueName };
}

/** Prepare before Vite starts; proxy and plugin share the same persistence root. */
export async function prepareLocalDevPeers(profile: DevProfile): Promise<void> {
  const { seedLocalUpc, seedLocalUsda } = await import(
    pathToFileURL(
      path.join(profile.webRoot, "tooling/local-dev-external-fixtures.ts"),
    ).href
  );
  const peers = await createLocalDevPeers(profile);
  for (const [index, peer] of peers.auxiliaryWorkers.slice(0, 2).entries()) {
    const proxy = await getPlatformProxy<{
      DB: D1Database;
      USDA_BUNDLES: R2Bucket;
      IMAGES: R2Bucket;
    }>({
      configPath: peer.configPath,
      envFiles: [],
      persist: { path: path.join(profile.stateDir, "cloudflare/v3") },
      remoteBindings: false,
    });
    try {
      if (index === 0) await seedLocalUsda(proxy.env);
      else await seedLocalUpc(proxy.env);
    } finally {
      await proxy.dispose();
    }
  }
}
