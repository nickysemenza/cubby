#!/usr/bin/env node
// The USDA picker entry is inlined before its `ui://` resource is served.
// Web commands pass --if-stale so gitignored bundles are refreshed without
// rebuilding on every dev server or test invocation.

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  mcpAppsBundleIsCurrent,
  mcpAppsSourceFingerprint,
  stampMcpAppsBundle,
} from "../../scripts/mcp-apps-fingerprint.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DIST = resolve(HERE, "dist");
const arguments_ = process.argv.slice(2);
const staleOnly = arguments_.length === 1 && arguments_[0] === "--if-stale";
if (arguments_.length > (staleOnly ? 1 : 0)) {
  throw new Error(`Unknown arguments: ${arguments_.join(", ")}`);
}

const fingerprint = mcpAppsSourceFingerprint(ROOT);
if (staleOnly) {
  if (mcpAppsBundleIsCurrent(fingerprint, DIST)) process.exit(0);
  process.stderr.write("[mcp-apps] bundles missing or stale — building…\n");
}

rmSync(DIST, { recursive: true, force: true });
await build({ configFile: resolve(HERE, "vite.config.ts") });
stampMcpAppsBundle(fingerprint, DIST);
