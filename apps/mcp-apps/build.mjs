#!/usr/bin/env node
// One pass per app is forced, not stylistic: vite-plugin-singlefile turns code
// splitting off so it can inline everything, and rollup rejects multiple inputs
// when splitting is off. Clearing dist/ once up front (rather than per pass)
// keeps each pass from wiping the previous one's output.
//
// Entry points are discovered from the `*.html` files here rather than listed,
// so `src/bundles.ts` stays the only place an app is declared.

import { readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));

const APPS = readdirSync(HERE)
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""))
  .sort();

if (APPS.length === 0) throw new Error("no *.html app entry points found");

rmSync(resolve(HERE, "dist"), { recursive: true, force: true });

for (const app of APPS) {
  process.env.MCP_APP = app;
  await build({ configFile: resolve(HERE, "vite.config.ts") });
}
