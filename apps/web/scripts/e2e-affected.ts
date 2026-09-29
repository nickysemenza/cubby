/**
 * Runs only the E2E specs a change affects, for fast local iteration
 * (`pnpm --dir apps/web test:e2e:affected`). CI keeps running every spec —
 * this is a local-only narrowing, not a merge gate.
 *
 * Changed files = the committed diff against `origin/main`'s merge base,
 * unioned with the working tree (staged, unstaged, and untracked files).
 * Each changed file is matched against `spec-areas.ts`'s per-spec globs and
 * `ALL_SPECS_TRIGGERS`. A changed file under `apps/web/src/**` or
 * `apps/web/tests/e2e/**` that matches neither is "unmapped" and fails safe
 * by selecting every spec (extend the manifest instead of trusting a narrow
 * selection when this happens).
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ALL_SPECS_TRIGGERS, SPEC_AREAS } from "../tests/e2e/spec-areas.ts";
import { ensureWebBuild } from "../tooling/web-build-provenance.ts";

const __filename = fileURLToPath(import.meta.url);
const WEB_DIR = path.resolve(path.dirname(__filename), "..");

function repoRoot(): string {
  return execFileSync("git", ["-C", WEB_DIR, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function gitLines(root: string, args: string[]): string[] {
  const out = execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Changed files, repo-root-relative, deduped. */
export function changedFiles(root: string): string[] {
  const sets = [
    // Committed changes since this branch diverged from origin/main.
    gitLines(root, ["diff", "--name-only", "origin/main...HEAD"]),
    // Working tree: staged, unstaged, and untracked (excluding ignored).
    gitLines(root, ["diff", "--name-only", "--cached"]),
    gitLines(root, ["diff", "--name-only"]),
    gitLines(root, ["ls-files", "--others", "--exclude-standard"]),
  ];
  return [...new Set(sets.flat())];
}

function matches(file: string, globs: readonly string[]): string | null {
  for (const glob of globs) {
    if (path.matchesGlob(file, glob)) return glob;
  }
  return null;
}

export interface AffectedResult {
  /** Spec files (relative to `tests/e2e/`), sorted, deduped. */
  specs: string[];
  /** One line per changed file explaining why it selected specs (or "all"). */
  reasons: string[];
  /** True if the fail-safe "select everything" path was taken. */
  ranEverything: boolean;
}

const MAPPABLE_PREFIXES = [
  "apps/web/src/",
  "apps/web/tests/e2e/",
  "apps/web/tooling/",
  "apps/web/scripts/",
  "scripts/",
];

export function computeAffected(
  changed: readonly string[],
  specAreas: readonly { file: string; globs: readonly string[] }[] = SPEC_AREAS,
  allTriggers: readonly string[] = ALL_SPECS_TRIGGERS,
): AffectedResult {
  const allSpecFiles = specAreas.map((entry) => entry.file).sort();
  const reasons: string[] = [];
  const selected = new Set<string>();
  let ranEverything = false;

  for (const file of changed) {
    const allTrigger = matches(file, allTriggers);
    if (allTrigger) {
      reasons.push(
        `${file} matches all-specs trigger "${allTrigger}" -> all specs`,
      );
      ranEverything = true;
      continue;
    }

    let matchedAny = false;
    for (const entry of specAreas) {
      const glob = matches(file, entry.globs);
      if (glob) {
        matchedAny = true;
        selected.add(entry.file);
        reasons.push(`${file} matches "${glob}" -> ${entry.file}`);
      }
    }

    if (
      !matchedAny &&
      MAPPABLE_PREFIXES.some((prefix) => file.startsWith(prefix))
    ) {
      reasons.push(
        `${file} is unmapped (no spec-areas.ts entry or all-specs trigger) -> all specs (extend apps/web/tests/e2e/spec-areas.ts)`,
      );
      ranEverything = true;
    }
  }

  const specs = ranEverything ? allSpecFiles : [...selected].sort();
  return { specs, reasons, ranEverything };
}

export async function runAffectedSpecs(
  root: string,
  specs: string[],
  passthrough: string[],
  execute: (
    command: string,
    args: string[],
    options: ExecFileSyncOptions,
  ) => void = execFileSync,
): Promise<void> {
  await ensureWebBuild(
    root,
    (skipCache) => {
      execute(
        "pnpm",
        [
          "exec",
          "nx",
          "run",
          "@cubby/web:build-cf",
          ...(skipCache ? ["--skip-nx-cache"] : []),
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: { ...process.env, NX_DAEMON: "false" },
        },
      );
    },
    process.env.CUBBY_E2E_PREBUILT_WEB === "1",
  );
  execute(
    process.execPath,
    [
      "../../scripts/test-services.ts",
      "--",
      "playwright",
      "test",
      ...specs,
      ...passthrough,
    ],
    {
      cwd: path.join(root, "apps/web"),
      stdio: "inherit",
      env: {
        ...process.env,
        CUBBY_TEST_SERVICES: process.env.CUBBY_TEST_SERVICES ?? "warm",
      },
    },
  );
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const json = args.includes("--json");
  const passthrough = args.filter(
    (arg) => !["--list", "--json", "--"].includes(arg),
  );

  const root = repoRoot();
  const changed = changedFiles(root);
  const { specs, reasons, ranEverything } = computeAffected(changed);

  if (json) {
    console.log(
      JSON.stringify(
        { changedFiles: changed, specs, reasons, ranEverything },
        null,
        2,
      ),
    );
    return;
  }

  if (changed.length === 0) {
    console.log("[e2e-affected] no changed files detected; nothing to run.");
    return;
  }

  console.log("[e2e-affected] changed files and why they matched:");
  for (const reason of reasons) console.log(`  ${reason}`);
  if (reasons.length === 0) {
    console.log(
      "  (no changed file matched a mapped route/feature glob or an all-specs trigger)",
    );
  }

  if (specs.length === 0) {
    console.log("[e2e-affected] no E2E specs affected; nothing to run.");
    return;
  }

  console.log(
    `[e2e-affected] ${ranEverything ? "running all" : "selected"} ${specs.length} spec(s):`,
  );
  for (const spec of specs) console.log(`  ${spec}`);

  if (listOnly) return;

  await runAffectedSpecs(root, specs, passthrough);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  await main();
}
