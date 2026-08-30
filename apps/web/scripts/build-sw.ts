/**
 * Builds the app-shell service worker into dist/client/sw.js and verifies that
 * no server-only code leaked into the client bundle.
 *
 * Why a standalone script instead of vite-plugin-pwa: under TanStack Start's
 * multi-environment build plus @cloudflare/vite-plugin, vite-plugin-pwa never
 * hooks the client build. This deterministic post-build step owns the finished
 * client tree: it creates the precache manifest, enforces its byte budgets, and
 * checks the same assets for server-only imports.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const CLIENT_DIR = path.resolve("dist/client");
const SW_ENTRY = path.resolve("src/sw.ts");
const SW_OUT = path.join(CLIENT_DIR, "sw.js");
const WASM_GZIP_BUDGET = 1.1 * 1024 * 1024;
const PRECACHE_GZIP_BUDGET = 1.35 * 1024 * 1024;
const SERVER_ONLY_MARKERS = ["drizzle-orm", "HYPERDRIVE"];

// Runtime JS chunks stay on normal HTTP/runtime caching; only stable app-shell
// support assets belong in the install-time precache.
const PRECACHE_EXT = new Set([".css", ".woff2", ".wasm", ".svg"]);
const PRECACHE_NAMED = new Set(["offline.html", "favicon.ico"]);
const PRECACHE_NAMED_PREFIX = ["icon-"];
const EXCLUDE_DIRS = new Set(["splash"]);

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      files.push(...(await walk(path.join(directory, entry.name))));
    } else {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function shouldPrecache(name: string): boolean {
  if (PRECACHE_NAMED.has(name)) return true;
  if (PRECACHE_NAMED_PREFIX.some((prefix) => name.startsWith(prefix)))
    return true;
  return PRECACHE_EXT.has(path.extname(name));
}

async function serverCodeLeaks(files: readonly string[]): Promise<string[]> {
  const leaks: string[] = [];
  for (const file of files) {
    if (path.extname(file) !== ".js") continue;
    const code = await readFile(file, "utf8");
    for (const marker of SERVER_ONLY_MARKERS) {
      if (code.includes(marker))
        leaks.push(`${path.basename(file)} contains "${marker}"`);
    }
  }
  return leaks;
}

async function assertNoServerCode(files: readonly string[]): Promise<void> {
  const leaks = await serverCodeLeaks(files);
  if (leaks.length === 0) return;
  throw new Error(
    `Server-only code leaked into the client bundle:\n  ${leaks.join("\n  ")}\n` +
      "The isomorphic transport split is not being stripped.",
  );
}

export async function assertNoServerCodeInClient(
  clientDirectory: string,
): Promise<void> {
  return assertNoServerCode(await walk(clientDirectory));
}

export async function buildServiceWorker(): Promise<void> {
  const files = await walk(CLIENT_DIR);
  await assertNoServerCode(files);

  const manifest: Array<{ url: string; revision: string }> = [];
  let precacheGzipBytes = 0;
  let wasmGzipBytes = 0;
  for (const file of files) {
    const name = path.basename(file);
    if (!shouldPrecache(name)) continue;
    const contents = await readFile(file);
    const url = `/${path.relative(CLIENT_DIR, file).split(path.sep).join("/")}`;
    const revision = createHash("md5")
      .update(contents)
      .digest("hex")
      .slice(0, 16);
    const gzipBytes = gzipSync(contents).byteLength;
    precacheGzipBytes += gzipBytes;
    if (path.extname(file) === ".wasm") wasmGzipBytes += gzipBytes;
    manifest.push({ url, revision });
  }
  manifest.sort((left, right) => left.url.localeCompare(right.url));

  if (wasmGzipBytes > WASM_GZIP_BUDGET)
    throw new Error(
      `WASM gzip budget exceeded: ${wasmGzipBytes} > ${WASM_GZIP_BUDGET}`,
    );
  if (precacheGzipBytes > PRECACHE_GZIP_BUDGET)
    throw new Error(
      `Precache gzip budget exceeded: ${precacheGzipBytes} > ${PRECACHE_GZIP_BUDGET}`,
    );

  await build({
    entryPoints: [SW_ENTRY],
    bundle: true,
    format: "iife",
    target: "es2020",
    minify: true,
    legalComments: "none",
    outfile: SW_OUT,
    define: { "self.__WB_MANIFEST": JSON.stringify(manifest) },
  });

  console.log(
    `[build-sw] wrote dist/client/sw.js — precaching ${manifest.length} assets (${precacheGzipBytes} bytes gzip; WASM ${wasmGzipBytes})`,
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) await buildServiceWorker();
