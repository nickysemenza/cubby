import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";
import { z } from "zod";
import type { DevProfile } from "../../../../scripts/lib/dev-profile.ts";

/** Derive local bindings from the deployed declarations, never its resource targets. */
export function writeLocalDevConfig(profile: DevProfile): string {
  const config = z
    .record(z.string(), z.json())
    .parse(
      parse(readFileSync(path.join(profile.webRoot, "wrangler.jsonc"), "utf8")),
    );
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
    hyperdrive: ["HYPERDRIVE", "HYPERDRIVE_CACHED"].map((binding) => ({
      binding,
      id: "00000000000000000000000000000000",
      localConnectionString: profile.databaseUrl,
    })),
    r2_buckets: [
      { binding: "LOCAL_DEV_STORAGE", bucket_name: `${name}-storage` },
      { binding: "USDA_RELEASES", bucket_name: usdaReleasesBucket(profile) },
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
      {
        binding: "VENDOR_MAIL_SEARCH",
        name: `${name}-vendor-mail-search`,
        class_name: "VendorMailSearchWorkflow",
      },
      {
        binding: "MAIL_DISCOVERY",
        name: `${name}-mail-discovery`,
        class_name: "MailDiscoveryWorkflow",
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

const usdaReleasesBucket = (profile: DevProfile) =>
  `cubby-dev-${profile.id}-usda-releases`;
