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
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extremeMtime } from "./mtime.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "apps/mcp-apps");
const DIST = join(PKG, "dist");
const PRUNE = new Set(["dist", "node_modules"]);
const WATCH_EXT = [".ts", ".html", ".css"];

const log = (msg: string) => process.stderr.write(`[ensure-mcp-apps] ${msg}\n`);

const build = () =>
  execFileSync("pnpm", ["--filter", "@cubby/mcp-apps", "run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
  });

const mtimeOf = (dir: string, pick: (a: number, b: number) => number, seed: number) =>
  extremeMtime(dir, {
    pick,
    seed,
    prune: PRUNE,
    extensions: WATCH_EXT,
  });
const newest = (dir: string) => mtimeOf(dir, Math.max, 0);
const oldest = (dir: string) => mtimeOf(dir, Math.min, Number.POSITIVE_INFINITY);

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
