/**
 * Builds the app-shell service worker into dist/client/sw.js.
 *
 * Why a standalone script instead of vite-plugin-pwa: under TanStack Start's
 * multi-environment (Vite Environments API) build + @cloudflare/vite-plugin,
 * vite-plugin-pwa never hooks the client build — it emits nothing, silently.
 * This codebase already handles CF build quirks with bespoke steps, so we do
 * the same: glob the finished client output, compute a content-hash precache
 * manifest, and bundle src/sw.ts with esbuild, injecting the manifest in place
 * of `self.__WB_MANIFEST`. Deterministic, debuggable, no plugin-ordering magic.
 *
 * Run after `vite build` (see the `build:cf` npm script). CWD is apps/web.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const CLIENT_DIR = path.resolve("dist/client");
const SW_ENTRY = path.resolve("src/sw.ts");
const SW_OUT = path.join(CLIENT_DIR, "sw.js");
const WASM_GZIP_BUDGET = 1.1 * 1024 * 1024;
const PRECACHE_GZIP_BUDGET = 1.35 * 1024 * 1024;

// Precache stable app-shell support assets. Runtime JS chunks are intentionally
// left to normal HTTP/runtime caching so SW install does not fetch every route.
const PRECACHE_EXT = new Set([".css", ".woff2", ".wasm", ".svg"]);
// ...plus these specific files by name (raster icons + the offline page)
const PRECACHE_NAMED = new Set(["offline.html", "favicon.ico"]);
const PRECACHE_NAMED_PREFIX = ["icon-"];
// Never precache the large iOS splash images (one per device — megabytes each).
const EXCLUDE_DIRS = new Set(["splash"]);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...(await walk(path.join(dir, entry.name))));
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function shouldPrecache(name) {
  if (PRECACHE_NAMED.has(name)) return true;
  if (PRECACHE_NAMED_PREFIX.some((p) => name.startsWith(p))) return true;
  return PRECACHE_EXT.has(path.extname(name));
}

const files = await walk(CLIENT_DIR);
const manifest = [];
let precacheGzipBytes = 0;
let wasmGzipBytes = 0;
for (const file of files) {
  const name = path.basename(file);
  if (!shouldPrecache(name)) continue;
  const buf = await readFile(file);
  const url = `/${path.relative(CLIENT_DIR, file).split(path.sep).join("/")}`;
  const revision = createHash("md5").update(buf).digest("hex").slice(0, 16);
  const gzipBytes = gzipSync(buf).byteLength;
  precacheGzipBytes += gzipBytes;
  if (path.extname(file) === ".wasm") wasmGzipBytes += gzipBytes;
  manifest.push({ url, revision });
}
manifest.sort((a, b) => a.url.localeCompare(b.url));

if (wasmGzipBytes > WASM_GZIP_BUDGET) {
  throw new Error(
    `WASM gzip budget exceeded: ${wasmGzipBytes} > ${WASM_GZIP_BUDGET}`,
  );
}
if (precacheGzipBytes > PRECACHE_GZIP_BUDGET) {
  throw new Error(
    `Precache gzip budget exceeded: ${precacheGzipBytes} > ${PRECACHE_GZIP_BUDGET}`,
  );
}

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
