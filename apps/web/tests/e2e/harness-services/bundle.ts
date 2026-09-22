import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Pre-bundle the tiny E2E harness service Workers (usda-empty, upc-empty,
 * purchase-agent-empty, queue-sink) once with esbuild, instead of letting
 * every Playwright worker's `createTestHarness()` re-bundle them from source
 * on every `listen()`/`reset()`. Output is cached by a hash of the entry
 * sources and the esbuild version; the only dependency, zod, is not hashed,
 * so delete `.bundle-cache` after a zod upgrade.
 *
 * `createHarness()` in e2e-worker-runtime.ts points each service's `main` at
 * the bundled file and sets `no_bundle: true`, so Miniflare loads it as-is.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cacheRoot = path.join(__dirname, ".bundle-cache");

const services = {
  usdaEmpty: "usda-empty.ts",
  upcEmpty: "upc-empty.ts",
  purchaseAgentEmpty: "purchase-agent-empty.ts",
  queueSink: "queue-sink.ts",
} as const;

export type HarnessServiceName = keyof typeof services;
export type HarnessServiceBundles = Record<HarnessServiceName, string>;

let cached: Promise<HarnessServiceBundles> | undefined;

async function sourceHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of Object.values(services)) {
    hash.update(file);
    hash.update(await readFile(path.join(__dirname, file)));
  }
  // Invalidate the cache if the esbuild version itself changes behavior.
  hash.update(esbuild.version);
  return hash.digest("hex").slice(0, 16);
}

/** Playwright workers are separate processes that bundle concurrently, so
 * each writes a private temp file and renames it into place: the output
 * path only ever holds a complete bundle. */
async function bundleOne(entry: string, outfile: string): Promise<void> {
  const temp = `${outfile}.${process.pid}.tmp`;
  await esbuild.build({
    entryPoints: [path.join(__dirname, entry)],
    outfile: temp,
    bundle: true,
    format: "esm",
    platform: "neutral",
    // Workers runtime globals (Response, Request, etc.) are ambient; nothing
    // Node-specific is imported by these harness services.
    target: "es2022",
    conditions: ["worker", "browser"],
  });
  await rename(temp, outfile);
}

/**
 * Ensure every harness service is bundled for the current sources, returning
 * each one's bundled file path. Memoized per process; safe to call from every
 * Playwright worker since the cache key is content-addressed.
 */
export function ensureHarnessServiceBundles(): Promise<HarnessServiceBundles> {
  cached ??= (async () => {
    const hash = await sourceHash();
    const dir = path.join(cacheRoot, hash);
    await mkdir(dir, { recursive: true });

    // SAFETY: populated below with exactly one entry per key of `services`
    // (the loop's only member type is `HarnessServiceName`), so every field
    // of `HarnessServiceBundles` is assigned before this function returns.
    const bundles = {} as HarnessServiceBundles;
    await Promise.all(
      // SAFETY: `services` is declared as `Record<HarnessServiceName, string>`,
      // so `Object.entries` keys are exactly `HarnessServiceName`.
      (Object.entries(services) as [HarnessServiceName, string][]).map(
        async ([name, entry]) => {
          const outfile = path.join(dir, `${name}.js`);
          try {
            await access(outfile);
          } catch {
            await bundleOne(entry, outfile);
          }
          bundles[name] = outfile;
        },
      ),
    );
    return bundles;
  })();
  return cached;
}
