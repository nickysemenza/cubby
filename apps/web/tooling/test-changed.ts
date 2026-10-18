import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Run the fast-tier test files affected by changes since a ref (default
 * `origin/main`): `pnpm test:changed [ref] [-- vitest args]`.
 *
 * Vitest's own `run --changed` (and `related`) reuses the transforms from the
 * affected-file graph walk it performs to choose the files, and the jsdom `ui`
 * project fails under those: measured, 44 of 246 files failed with leaked
 * trees ("Found multiple elements") while the same files listed by
 * `vitest list --changed` and then run in a fresh process all passed. So the
 * choice and the run stay in separate processes.
 */
const PROJECTS = ["unit", "mcp-contract", "worker-safety", "ui"];
// The CLI entry is the package's `bin`, which its exports map does not expose.
const vitest = fileURLToPath(
  new URL("vitest.mjs", import.meta.resolve("vitest/package.json")),
);
const separator = process.argv.indexOf("--");
const own =
  separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const forwarded = separator === -1 ? [] : process.argv.slice(separator + 1);
const since = own[0] ?? "origin/main";
const projectArgs = PROJECTS.flatMap((project) => ["--project", project]);

const listed = execFileSync(
  process.execPath,
  [vitest, "list", "--filesOnly", "--changed", since, ...projectArgs],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const files = [
  ...new Set(
    listed
      .split("\n")
      .map((line) => /^\[[\w-]+\] (\S+)$/u.exec(line.trim())?.[1])
      .filter((file) => file !== undefined),
  ),
];
if (!files.length) {
  console.log(`test:changed: no fast-tier tests are affected since ${since}`);
  process.exit(0);
}
console.log(`test:changed: ${files.length} affected test files since ${since}`);
const run = spawnSync(
  process.execPath,
  [vitest, "run", ...projectArgs, ...forwarded, ...files],
  { stdio: "inherit" },
);
process.exit(run.status ?? 1);
