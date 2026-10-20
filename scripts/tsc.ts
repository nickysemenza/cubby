#!/usr/bin/env node
// Local and CI checks share tsrs and its declaration output contract.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Node-script path of tsrs; spawn it with process.execPath. */
export const typeChecker = join(
  dirname(fileURLToPath(import.meta.resolve("tsrs/package.json"))),
  "bin/tsrs",
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync(
    process.execPath,
    [typeChecker, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
