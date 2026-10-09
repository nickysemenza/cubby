import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { R2Bucket } from "@cloudflare/workers-types";
import { getPlatformProxy } from "wrangler";
import { parse } from "jsonc-parser";
import { z } from "zod";
import type { DevProfile } from "../../../../scripts/lib/dev-profile.ts";
import type { UsdaReleaseFile } from "./usda-synthetic-release.ts";

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

/**
 * Seed the dev Worker's `USDA_RELEASES` bucket before Vite starts: the
 * synthetic release, or the built release `CUBBY_DEV_USDA_RELEASE_DIR` names.
 * The proxy shares the dev Worker's persistence root, and `USDA_ACTIVE_RELEASE`
 * (dev-profile.ts) names the same release. The release modules load lazily
 * so vite.config.ts, which imports this file, stays light.
 */
export async function prepareLocalUsdaRelease(
  profile: DevProfile,
): Promise<void> {
  const { seedUsdaRelease, syntheticUsdaReleaseFiles } =
    await import("./usda-synthetic-release.ts");
  const release = profile.vars.USDA_ACTIVE_RELEASE;
  if (!release) throw new Error("The dev profile has no USDA_ACTIVE_RELEASE");
  const configPath = path.join(profile.stateDir, "config/usda-releases.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({
      name: `cubby-dev-${profile.id}-usda-seed`,
      compatibility_date: "2026-09-19",
      r2_buckets: [
        { binding: "USDA_RELEASES", bucket_name: usdaReleasesBucket(profile) },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const proxy = await getPlatformProxy<{ USDA_RELEASES: R2Bucket }>({
    configPath,
    envFiles: [],
    // The plugin and Wrangler CLI append v3; the programmatic proxy does not.
    persist: { path: path.join(profile.stateDir, "cloudflare/v3") },
    remoteBindings: false,
  });
  try {
    if (!profile.usdaReleaseDir)
      await seedUsdaRelease(
        proxy.env.USDA_RELEASES,
        syntheticUsdaReleaseFiles(release),
      );
    // One shard in memory at a time; the manifest comes last.
    else
      for await (const file of readUsdaReleaseDir(
        profile.usdaReleaseDir,
        release,
      ))
        await seedUsdaRelease(proxy.env.USDA_RELEASES, [file]);
  } finally {
    await proxy.dispose();
  }
}

/** A `release:build` output directory, keyed as R2 holds it. */
async function* readUsdaReleaseDir(
  dir: string,
  release: string,
): AsyncGenerator<UsdaReleaseFile> {
  const { manifestKey, RELEASE_MANIFEST_FILE, releaseManifest, shardKey } =
    await import("@cubby/usda/release");
  const manifest = releaseManifest.parse(
    JSON.parse(await readFile(path.join(dir, RELEASE_MANIFEST_FILE), "utf8")),
  );
  if (manifest.release !== release)
    throw new Error(`${dir} holds release ${manifest.release}, not ${release}`);
  const keys = [
    ...Array.from({ length: manifest.shardCount }, (_, index) =>
      shardKey(manifest.release, index),
    ),
    manifestKey(manifest.release),
  ];
  for (const key of keys)
    yield { key, body: await readFile(path.join(dir, path.basename(key))) };
}
