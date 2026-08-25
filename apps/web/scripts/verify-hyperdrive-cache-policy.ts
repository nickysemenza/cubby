import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HYPERDRIVE_CACHE_POLICY } from "../src/lib/hyperdrive-cache-policy";

type HyperdriveConfig = {
  id: string;
  caching?: {
    disabled?: boolean;
    max_age?: number;
    stale_while_revalidate?: number;
  };
};

export const parseWranglerJson = (output: string): HyperdriveConfig => {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("Wrangler returned no Hyperdrive JSON");
  return JSON.parse(output.slice(start)) as HyperdriveConfig;
};

export const assertHyperdriveCachePolicy = (config: HyperdriveConfig): void => {
  const caching = config.caching;
  const mismatches = [
    caching?.disabled === false ? null : "caching must be enabled",
    caching?.max_age === HYPERDRIVE_CACHE_POLICY.maxAgeSeconds
      ? null
      : `max_age expected ${HYPERDRIVE_CACHE_POLICY.maxAgeSeconds}, received ${String(caching?.max_age)}`,
    caching?.stale_while_revalidate ===
    HYPERDRIVE_CACHE_POLICY.staleWhileRevalidateSeconds
      ? null
      : `stale_while_revalidate expected ${HYPERDRIVE_CACHE_POLICY.staleWhileRevalidateSeconds}, received ${String(caching?.stale_while_revalidate)}`,
  ].filter((value): value is string => value !== null);

  if (mismatches.length > 0) {
    throw new Error(
      `HYPERDRIVE_CACHED policy drift for ${config.id}: ${mismatches.join("; ")}`,
    );
  }
};

const cachedHyperdriveId = (): string => {
  const configPath = fileURLToPath(
    new URL("../wrangler.jsonc", import.meta.url),
  );
  const source = readFileSync(configPath, "utf8");
  const match =
    /"binding"\s*:\s*"HYPERDRIVE_CACHED"\s*,\s*"id"\s*:\s*"([^"]+)"/u.exec(
      source,
    );
  if (!match?.[1]) throw new Error("HYPERDRIVE_CACHED id is missing");
  return match[1];
};

export const verifyLiveHyperdriveCachePolicy = (): void => {
  const id = cachedHyperdriveId();
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "hyperdrive", "get", id],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect HYPERDRIVE_CACHED: ${result.stderr || result.stdout}`,
    );
  }
  assertHyperdriveCachePolicy(parseWranglerJson(result.stdout));
  console.log(
    `HYPERDRIVE_CACHED matches max_age=${HYPERDRIVE_CACHE_POLICY.maxAgeSeconds}s stale_while_revalidate=${HYPERDRIVE_CACHE_POLICY.staleWhileRevalidateSeconds}s`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyLiveHyperdriveCachePolicy();
}
