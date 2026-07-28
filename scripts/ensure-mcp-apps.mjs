#!/usr/bin/env node
// Rebuild the gitignored MCP App bundles only when a source is newer than the
// newest built artifact.
//
// The bundles are `?raw`-imported through @cubby/mcp-apps, so their absence is
// a hard error at import time and a stale dist/ is a *silent* one — an old UI
// ships and nothing complains. Hence mtime comparison rather than a mere
// existence check. Mirrors ensure-wasm.mjs; gates apps/web's dev, test, and
// build:cf.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "apps/mcp-apps");
const DIST = join(PKG, "dist");
const PRUNE = new Set(["dist", "node_modules"]);
const WATCH_EXT = [".ts", ".html", ".css"];

const log = (msg) => process.stderr.write(`[ensure-mcp-apps] ${msg}\n`);

const build = () =>
  execFileSync("pnpm", ["--filter", "@cubby/mcp-apps", "run", "build"], {
    cwd: ROOT,
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

// The shared design tokens are an input too: a palette change there must
// invalidate the bundles, which inline it.
const sources = Math.max(newest(PKG), newest(join(ROOT, "packages/design-tokens")));

if (sources <= oldest(DIST)) process.exit(0);

log("MCP app source changed — building…");
build();
