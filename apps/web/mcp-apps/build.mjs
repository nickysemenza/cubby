#!/usr/bin/env node
// Build every MCP App bundle, one vite pass each.
//
// One pass per app is forced, not stylistic: vite-plugin-singlefile turns code
// splitting off so it can inline everything, and rollup rejects multiple inputs
// when splitting is off. Clearing dist/ once up front (rather than per pass)
// keeps each pass from wiping the previous one's output.

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS = ["shopping-list", "usda-picker"];

rmSync(resolve(HERE, "dist"), { recursive: true, force: true });

for (const app of APPS) {
  process.env.MCP_APP = app;
  await build({ configFile: resolve(HERE, "vite.config.ts") });
}
