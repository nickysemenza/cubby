/**
 * Pre-commit typecheck, scoped to what is actually staged.
 *
 * The hook used to run the full `pnpm typecheck` on every commit — 11s warm,
 * 43s cold, paid even when the commit only touched Markdown or `.claude/`.
 * Across 21 days of agent transcripts `git add …` and `git commit …` cost
 * **3.2h**, almost entirely this hook.
 *
 * Scope classification is delegated to `classifyPaths`, the same source of
 * truth CI uses to decide which jobs run, rather than a second parallel
 * heuristic that could drift from it. It already fails safe: an unrecognised
 * path, or anything under a shared root like `.github/` or `scripts/`, marks
 * every workspace dirty and we fall back to the full run.
 *
 * `--filter <pkg>...` (with the trailing ellipsis) includes each package's
 * dependencies, so a staged change in `packages/schemas` is still typechecked
 * through the app that consumes it.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPaths } from "./ci-scope.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const staged = spawnSync(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
  { cwd: repoRoot, encoding: "utf8" },
);
if (staged.status !== 0) {
  console.error("typecheck-staged: could not list staged files; running full typecheck");
}

const paths = (staged.stdout ?? "").split("\n").filter(Boolean);
const scope = staged.status === 0 ? classifyPaths(paths) : null;

function run(args: string[]): number {
  const result = spawnSync("pnpm", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

if (scope?.inert) {
  console.error(
    `typecheck-staged: ${paths.length} staged file(s), none affect typed code — skipping.`,
  );
  process.exit(0);
}

const filters: string[] = [];
if (scope && !scope.unknown) {
  if (scope.web) filters.push("--filter", "@cubby/web...");
  if (scope.usda) filters.push("--filter", "@cubby/usda-api...");
  if (scope.upc) filters.push("--filter", "@cubby/upc-lookup...");
}

if (filters.length === 0) {
  console.error("typecheck-staged: broad or unclassified change — full typecheck.");
  process.exit(run(["typecheck"]));
}

console.error(
  `typecheck-staged: ${filters.filter((f) => f !== "--filter").join(", ")}`,
);
process.exit(run([...filters, "--parallel", "typecheck"]));
