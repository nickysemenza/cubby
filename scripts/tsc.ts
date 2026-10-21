#!/usr/bin/env node
// Local and CI checks share tsrs and its declaration output contract.
// One checker avoids duplicating the type graph in every parallel worktree.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const compiler = join(
  dirname(fileURLToPath(import.meta.resolve("tsrs/package.json"))),
  "bin/tsrs",
);

/** Policy-owning Node launcher; imported callers use the same checker count. */
export const typeChecker = fileURLToPath(import.meta.url);

if (process.argv[1] === typeChecker) {
  const result = spawnSync(
    process.execPath,
    // Build mode must remain the first argument.
    [compiler, ...process.argv.slice(2), "--checkers", "1"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
