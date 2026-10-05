import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { getPlatformProxy } from "wrangler";
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
        { binding: "PURCHASE_AGENT_QUEUE", queue: `${name}-purchase` },
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
        // Offline development refuses the producer handoff (dev/worker.ts),
        // so only the integrations profile delivers agent events.
        {
          queue: `${name}-purchase`,
          max_batch_size: 10,
          max_batch_timeout: 0,
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

export async function createLocalDevPeers(profile: DevProfile) {
  const configRoot = path.join(profile.stateDir, "peers");
  await mkdir(configRoot, { recursive: true });
  const prefix = `cubby-dev-${profile.id}`;
  const services = { USDA_API: `${prefix}-usda` };
  const common = {
    compatibility_date: "2026-09-19",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: false },
  };
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
  ];
  const auxiliaryWorkers: Array<{ configPath: string; devOnly: true }> = [];
  for (const config of configs) {
    const configPath = path.join(configRoot, `${config.name}.json`);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    auxiliaryWorkers.push({ configPath, devOnly: true });
  }
  return { auxiliaryWorkers, services };
}

/** Prepare before Vite starts; proxy and plugin share the same persistence root. */
export async function prepareLocalDevPeers(profile: DevProfile): Promise<void> {
  const peers = await createLocalDevPeers(profile);
  for (const peer of peers.auxiliaryWorkers.slice(0, 1)) {
    const proxy = await getPlatformProxy<{
      DB: D1Database;
      USDA_BUNDLES: R2Bucket;
    }>({
      configPath: peer.configPath,
      envFiles: [],
      persist: { path: path.join(profile.stateDir, "cloudflare/v3") },
      remoteBindings: false,
    });
    try {
      await seedLocalUsda(proxy.env);
    } finally {
      await proxy.dispose();
    }
  }
}

const VERSION = "vlocal1";

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
