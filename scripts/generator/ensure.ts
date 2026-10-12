#!/usr/bin/env node
// Brings the never-committed generated output current, so install, build,
// typecheck and test can all depend on it. Nx owns staleness: the
// `cubby-checks:generate` target declares the generator's inputs and outputs,
// so an unchanged checkout is a cache hit that also restores any missing or
// edited output file.
//
//   ensure.ts                generate if stale
//   ensure.ts --force        always generate
//   ensure.ts --postinstall  generate if stale, but skip a filtered install
//                            that left out the web app's dependencies
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ROOT, runNxTarget } from "../rust-fingerprint.ts";
import { ARTIFACT_MANIFEST, removeExtraArtifacts } from "./artifacts.ts";

if (
  process.argv.includes("--postinstall") &&
  !existsSync(join(ROOT, "apps/web/node_modules"))
) {
  console.log("generate: skipped (filtered install without apps/web)");
  process.exit(0);
}

runNxTarget(
  "generate",
  process.argv.includes("--force") ? ["--skip-nx-cache"] : [],
);

// Also inside an Nx task, where the enclosing graph ran (or replayed)
// `generate`: replay restores files but never removes extra ones.
const manifest = join(ROOT, ARTIFACT_MANIFEST);
if (existsSync(manifest)) {
  const paths: string[] = JSON.parse(readFileSync(manifest, "utf8"));
  for (const path of await removeExtraArtifacts(
    ROOT,
    paths.map((relativePath) => ({ relativePath })),
  ))
    console.log(`generate: removed stale ${path}`);
}
