#!/usr/bin/env node
// Rebuild the gitignored MCP Apps UI bundles only when a source is newer than
// the newest built artifact.
//
// The bundles are `?raw`-imported into the worker (see
// apps/web/src/server/mcp/apps/index.ts), so a stale dist/ doesn't fail the
// build — it silently ships an old UI. That's why this compares mtimes rather
// than just checking existence. Mirrors ensure-wasm.mjs, wired into `pnpm dev`
// and ahead of `build:cf`.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "apps/web/mcp-apps");
const DIST = join(APP_DIR, "dist");
const PRUNE = new Set(["dist", "node_modules"]);
const WATCH_EXT = [".ts", ".html", ".css"];

const log = (msg) => process.stderr.write(`[ensure-mcp-apps] ${msg}\n`);

const build = () =>
  execFileSync("pnpm", ["run", "build:mcp-apps"], {
    cwd: join(ROOT, "apps/web"),
    stdio: "inherit",
  });

/** Extreme mtime (ms) across watched files under `dir`. */
const mtimeOf = (dir, pick, seed) => {
  let acc = seed;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) acc = pick(acc, mtimeOf(full, pick, seed));
    } else if (WATCH_EXT.some((ext) => e.name.endsWith(ext))) {
      try {
        acc = pick(acc, statSync(full).mtimeMs);
      } catch {
        /* unreadable entry — ignore */
      }
    }
  }
  return acc;
};

const newest = (dir) => mtimeOf(dir, Math.max, 0);
// Oldest, not newest: if any one bundle is behind a source edit, rebuild all.
const oldest = (dir) => mtimeOf(dir, Math.min, Number.POSITIVE_INFINITY);

if (!existsSync(DIST) || !readdirSync(DIST).some((f) => f.endsWith(".html"))) {
  log("no MCP app bundles — building…");
  build();
  process.exit(0);
}

if (newest(APP_DIR) <= oldest(DIST)) process.exit(0);

log("MCP app source changed — building…");
build();
