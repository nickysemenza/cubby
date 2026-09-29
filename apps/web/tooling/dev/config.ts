import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { Plugin } from "vite";
import type { WorkerConfig } from "@cloudflare/vite-plugin";
import { getPlatformProxy, type Unstable_RawConfig } from "wrangler";
import { parse } from "jsonc-parser";
import { z } from "zod";
import type { DevProfile } from "../../../../scripts/lib/dev-profile.ts";

/** Derive local bindings from the deployed declarations, never its resource targets. */
export async function writeLocalDevConfig(
  profile: DevProfile,
): Promise<string> {
  const config = z
    .record(z.string(), z.json())
    .parse(
      parse(readFileSync(path.join(profile.webRoot, "wrangler.jsonc"), "utf8")),
    );
  const peers = await createLocalDevPeers(profile);
  const name = `cubby-dev-${profile.id}`;
  for (const key of [
    "routes",
    "placement",
    "triggers",
    "ai",
    "vectorize",
    "vars",
    "services",
    "hyperdrive",
    "queues",
    "observability",
  ])
    delete config[key];
  Object.assign(config, {
    name,
    main: path.join(profile.webRoot, "tooling/dev/worker.ts"),
    workers_dev: false,
    preview_urls: false,
    secrets: { required: [] },
    vars: profile.vars,
    observability: { enabled: true },
    services: Object.entries(peers.services).map(([binding, service]) => ({
      binding,
      service,
    })),
    hyperdrive: ["HYPERDRIVE", "HYPERDRIVE_CACHED"].map((binding) => ({
      binding,
      id: "00000000000000000000000000000000",
      localConnectionString: profile.databaseUrl,
    })),
    r2_buckets: [
      { binding: "LOCAL_DEV_STORAGE", bucket_name: `${name}-storage` },
    ],
    queues: {
      producers: [
        { binding: "BACKGROUND_QUEUE", queue: `${name}-background` },
        { binding: "TELEMETRY_QUEUE", queue: `${name}-telemetry` },
        { binding: "PURCHASE_AGENT_QUEUE", queue: peers.queueName },
      ],
      consumers: [
        {
          queue: `${name}-background`,
          max_batch_size: 1,
          max_batch_timeout: 0,
          max_concurrency: 1,
          max_retries: 3,
        },
        {
          queue: `${name}-telemetry`,
          max_batch_size: 100,
          max_batch_timeout: 5,
          max_concurrency: 1,
          max_retries: 3,
        },
      ],
    },
    workflows: [
      {
        binding: "SEARCH_INDEX_REPAIR",
        name: `${name}-search-index-repair`,
        class_name: "SearchIndexRepairWorkflow",
      },
    ],
  });
  if (profile.integration) {
    config.ai = { binding: "AI", remote: true };
    config.vectorize = [
      {
        binding: "VECTORIZE",
        index_name: profile.integration.vectorizeIndex,
        remote: true,
      },
    ];
  }
  const destination = path.join(profile.stateDir, "config/main.json");
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return destination;
}

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
    main: path.join(profile.webRoot, "tooling/dev/offline-purchase.ts"),
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

const VERSION = "vlocal1";
const LOCAL_FIXTURE_UPC = "012345678905";

/** Small synthetic data exercises the actual D1 index + R2 range-read path. */
async function seedLocalUsda(env: {
  DB: D1Database;
  USDA_BUNDLES: R2Bucket;
}): Promise<void> {
  const { foodSummary } = await import("@cubby/usda");
  const foods = [
    {
      id: 9900001,
      name: "Synthetic rolled oats",
      nutrients: { "208": 380, "203": 12, "204": 7, "205": 67 },
    },
    {
      id: 9900002,
      name: "Synthetic fresh apple",
      nutrients: { "208": 52, "203": 0.3, "204": 0.2, "205": 14 },
    },
    {
      id: 9900003,
      name: "Synthetic plain yogurt",
      nutrients: { "208": 61, "203": 3.5, "204": 3.3, "205": 4.7 },
    },
  ].map((fixture) =>
    foodSummary.parse({
      fdc_id: fixture.id,
      foodInfo: { data_type: "foundation_food", description: fixture.name },
      brandedFoodInfo: null,
      legacyFoodInfo: null,
      nutritionInfo: {
        nutrientSummary: [],
        nutrientsPer100: fixture.nutrients,
      },
      portionInfoRaw: [],
    }),
  );
  await env.DB
    .exec(`CREATE TABLE IF NOT EXISTS usda_edge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS food_cache (version TEXT NOT NULL, fdc_id INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(version,fdc_id));
    CREATE TABLE IF NOT EXISTS food_index_${VERSION} (fdc_id INTEGER PRIMARY KEY, data_type TEXT NOT NULL, description TEXT NOT NULL, short_description TEXT, brand_name TEXT, brand_owner TEXT, gtin_upc TEXT, ndb_number INTEGER, bundle_key TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS food_search_${VERSION} USING fts5(fdc_id UNINDEXED, data_type UNINDEXED, description, tokenize='unicode61 remove_diacritics 1');
    DELETE FROM food_search_${VERSION}; DELETE FROM food_index_${VERSION}; DELETE FROM food_cache;`);
  const key = `usda/${VERSION}/bundles/food-000000.ndjson`;
  let offset = 0;
  const lines: string[] = [];
  const statements = [];
  for (const food of foods) {
    const line = JSON.stringify(food);
    const length = Buffer.byteLength(line);
    statements.push(
      env.DB.prepare(
        `INSERT INTO food_index_${VERSION} (fdc_id, data_type, description, bundle_key, byte_offset, byte_length) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        food.fdc_id,
        food.foodInfo.data_type,
        food.foodInfo.description,
        key,
        offset,
        length,
      ),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO food_search_${VERSION} (fdc_id, data_type, description) VALUES (?, ?, ?)`,
      ).bind(food.fdc_id, food.foodInfo.data_type, food.foodInfo.description),
    );
    offset += length + 1;
    lines.push(line);
  }
  await env.USDA_BUNDLES.put(key, `${lines.join("\n")}\n`, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  await env.USDA_BUNDLES.put(
    `usda/${VERSION}/manifest.json`,
    JSON.stringify({
      counts: {
        usda_food: foods.length,
        usda_branded_food: 0,
        usda_nutrient: 4,
        usda_food_nutrient: foods.length * 4,
        usda_measure_unit: 0,
        usda_food_portion: 0,
        usda_sr_legacy_food: 0,
      },
    }),
  );
  statements.push(
    env.DB.prepare(
      "INSERT OR REPLACE INTO usda_edge_meta (key,value) VALUES ('active_version', ?)",
    ).bind(VERSION),
  );
  await env.DB.batch(statements);
}

async function seedLocalUpc(env: {
  DB: D1Database;
  IMAGES: R2Bucket;
}): Promise<void> {
  await env.DB
    .exec(`CREATE TABLE IF NOT EXISTS products (upc TEXT PRIMARY KEY, name TEXT NOT NULL, manufacturer TEXT, brand TEXT, category TEXT, description TEXT, price_dollars REAL, image_key TEXT, source TEXT NOT NULL, source_data TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_manufacturer ON products(manufacturer);
    CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
    CREATE TABLE IF NOT EXISTS upc_misses (upc TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 1, last_checked_at TEXT DEFAULT (datetime('now')));`);
  const key = `images/${LOCAL_FIXTURE_UPC}.png`;
  const bytes = await readFile(
    new URL(
      "../../tests/e2e/fixtures/synthetic-wardrobe-shirt.png",
      import.meta.url,
    ),
  );
  await env.IMAGES.put(key, bytes, {
    httpMetadata: { contentType: "image/png" },
  });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO products (upc,name,manufacturer,brand,category,description,price_dollars,image_key,source) VALUES (?, 'Synthetic cotton shirt', 'Synthetic Works', 'Synthetic', 'Clothing', 'Local synthetic barcode fixture', 18, ?, 'manual')`,
  )
    .bind(LOCAL_FIXTURE_UPC, key)
    .run();
}
