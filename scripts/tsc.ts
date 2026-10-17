#!/usr/bin/env node
// Every typecheck runs through this compiler. CUBBY_TYPECHECKER=tsgo selects
// TypeScript 7's own checker (CI's gate); the default tsrs is a Rust port with
// the same diagnostics and declaration bytes at a fraction of the time and heap.
// tsgo's heap grows with each parallel checker, so it runs one; tsrs's parallel
// checkers peak below that single tsgo checker and run ~20x faster than one.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const checkers = {
  tsrs: ["tsrs/package.json", "bin/tsrs"],
  tsgo: ["typescript/package.json", "bin/tsc"],
} as const;

const selected = process.env.CUBBY_TYPECHECKER || "tsrs";
if (selected !== "tsrs" && selected !== "tsgo")
  throw new Error(`CUBBY_TYPECHECKER must be tsrs or tsgo; got ${selected}`);
const [manifest, bin] = checkers[selected];

/** Trailing checker-count flags: tsc requires --build to come first. */
export const checkerFlags = selected === "tsgo" ? ["--checkers", "1"] : [];

/** Node-script path of the selected compiler; spawn it with process.execPath. */
export const typeChecker = join(
  dirname(fileURLToPath(import.meta.resolve(manifest))),
  bin,
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync(
    process.execPath,
    [typeChecker, ...process.argv.slice(2), ...checkerFlags],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
