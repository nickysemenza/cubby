#!/usr/bin/env node
// `wrangler types` types the Durable Object and Workflow bindings through the
// Worker entry (`import("./src/cf-server")`). worker-configuration.d.ts is a
// global script, so that import put a global file in nearly every edit's
// importer closure, and TypeScript then re-checks the whole program
// (docs/local-check-performance.md#typechecking). Point the types at
// src/server/worker-bindings.ts, which exports exactly those classes.
//
// `--check` fails while the file still imports the entry. Wrangler's own
// `--check` compares only the generated hash header, which this leaves intact.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(import.meta.dirname, "../worker-configuration.d.ts");
const ENTRY = 'import("./src/cf-server")';
const BINDINGS = 'import("./src/server/worker-bindings")';

const text = readFileSync(FILE, "utf8");
if (!process.argv.includes("--check")) {
  writeFileSync(FILE, text.replaceAll(ENTRY, BINDINGS));
} else if (text.includes(ENTRY)) {
  console.error(
    "worker-configuration.d.ts imports the Worker entry; run `pnpm --dir apps/web types:generate`.",
  );
  process.exit(1);
}
