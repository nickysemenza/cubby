#!/usr/bin/env node
// The USDA picker entry is inlined before its `ui://` resource is served.
// Web commands pass --if-stale so gitignored bundles are refreshed without
// rebuilding on every dev server or test invocation.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = resolve(HERE, "dist");
const arguments_ = process.argv.slice(2);
const staleOnly = arguments_.length === 1 && arguments_[0] === "--if-stale";
if (arguments_.length > (staleOnly ? 1 : 0)) {
  throw new Error(`Unknown arguments: ${arguments_.join(", ")}`);
}

const inputFiles = [
  resolve(HERE, "app.html"),
  fileURLToPath(import.meta.url),
  resolve(HERE, "vite.config.ts"),
  resolve(HERE, "src/app.css"),
  resolve(HERE, "src/origin.ts"),
  resolve(HERE, "src/usda-picker.ts"),
  resolve(ROOT, "packages/design-tokens/brand.css"),
];

const bundles = () =>
  existsSync(DIST)
    ? readdirSync(DIST).filter((file) => file.endsWith(".html"))
    : [];

if (staleOnly) {
  const outputFiles = bundles();
  if (outputFiles.length > 0) {
    const newestInput = Math.max(
      ...inputFiles.map((file) => statSync(file).mtimeMs),
    );
    const oldestBundle = Math.min(
      ...outputFiles.map((file) => statSync(resolve(DIST, file)).mtimeMs),
    );
    if (newestInput <= oldestBundle) process.exit(0);
  }
  process.stderr.write("[mcp-apps] bundles missing or stale — building…\n");
}

rmSync(DIST, { recursive: true, force: true });
await build({ configFile: resolve(HERE, "vite.config.ts") });
