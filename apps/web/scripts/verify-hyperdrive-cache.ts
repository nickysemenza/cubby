import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type HyperdriveDetails = {
  caching?: { disabled?: boolean };
};

export function extractHyperdriveId(config: string): string {
  const binding = config.match(
    /"binding"\s*:\s*"HYPERDRIVE"[\s\S]*?"id"\s*:\s*"([^"]+)"/u,
  );
  if (!binding?.[1]) {
    throw new Error("wrangler.jsonc has no HYPERDRIVE binding id");
  }
  return binding[1];
}

export function assertHyperdriveCacheDisabled(details: unknown): void {
  const parsed = details as HyperdriveDetails;
  if (parsed.caching?.disabled !== true) {
    throw new Error(
      "Hyperdrive query caching must remain disabled; live configuration reported caching enabled or unknown",
    );
  }
}

function parseWranglerJson(output: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Wrangler returned no Hyperdrive JSON payload");
  }
  return JSON.parse(output.slice(start, end + 1));
}

export function verifyHyperdriveCachePolicy(): void {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const config = readFileSync(resolve(appRoot, "wrangler.jsonc"), "utf8");
  const id = extractHyperdriveId(config);
  const result = spawnSync("wrangler", ["hyperdrive", "get", id], {
    cwd: appRoot,
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect Hyperdrive ${id}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  assertHyperdriveCacheDisabled(parseWranglerJson(result.stdout));
  console.log(`Hyperdrive ${id}: query caching disabled (expected)`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) verifyHyperdriveCachePolicy();
