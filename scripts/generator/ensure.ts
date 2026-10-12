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
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ROOT, runNxTarget } from "../rust-fingerprint.ts";

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
