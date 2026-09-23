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

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ALL_SPECS_TRIGGERS, SPEC_AREAS } from "../tests/e2e/spec-areas.ts";

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

/**
 * Compiles a glob (supporting `*`, `**`, and `?`) into a RegExp anchored to
 * the full string. Good enough for the path-glob vocabulary used in
 * `spec-areas.ts`; not a general-purpose glob implementation.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else if (c === "?") {
      pattern += "[^/]";
    } else if (c && /[.+^${}()|[\]\\]/.test(c)) {
      pattern += `\\${c}`;
    } else {
      pattern += c;
    }
  }
  return new RegExp(`^${pattern}$`);
}

function matches(file: string, globs: readonly string[]): string | null {
  for (const glob of globs) {
    if (globToRegExp(glob).test(file)) return glob;
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

const MAPPABLE_PREFIXES = ["apps/web/src/", "apps/web/tests/e2e/"];

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
        if (!selected.has(entry.file)) {
          selected.add(entry.file);
          reasons.push(`${file} matches "${glob}" -> ${entry.file}`);
        }
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

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const passthrough = args.filter((arg) => arg !== "--list");

  const root = repoRoot();
  const changed = changedFiles(root);
  const { specs, reasons, ranEverything } = computeAffected(changed);

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

  process.env.CUBBY_TEST_SERVICES ??= "warm";
  execFileSync(
    "node",
    [
      "../../scripts/test-services.ts",
      "--",
      "playwright",
      "test",
      ...specs,
      ...passthrough,
    ],
    { cwd: WEB_DIR, stdio: "inherit", env: process.env },
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  await main();
}
