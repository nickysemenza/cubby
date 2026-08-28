#!/usr/bin/env node
// Rebuild the gitignored USDA picker document only when one of its bundle
// inputs is newer than the built artifact.
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
const log = (msg: string) => process.stderr.write(`[ensure-mcp-apps] ${msg}\n`);

const build = () =>
  execFileSync("pnpm", ["--filter", "@cubby/mcp-apps", "run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
  });

const inputFiles = [
  join(PKG, "app.html"),
  join(PKG, "build.mjs"),
  join(PKG, "vite.config.ts"),
  join(PKG, "src", "app.css"),
  join(PKG, "src", "origin.ts"),
  join(PKG, "src", "usda-picker.ts"),
  join(ROOT, "packages", "design-tokens", "brand.css"),
];
const newestInput = Math.max(
  ...inputFiles.map((file) => statSync(file).mtimeMs),
);
const oldestBundle = () =>
  Math.min(
    ...readdirSync(DIST)
      .filter((file) => file.endsWith(".html"))
      .map((file) => statSync(join(DIST, file)).mtimeMs),
  );

if (!existsSync(DIST) || !readdirSync(DIST).some((f) => f.endsWith(".html"))) {
  log("no MCP app bundles — building…");
  build();
  process.exit(0);
}

if (newestInput <= oldestBundle()) process.exit(0);

log("MCP app source changed — building…");
build();
