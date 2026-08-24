/**
 * Concurrent runner for `pnpm check`.
 *
 * The gates were strictly serial (`a && b && c && …`), which cost the sum of
 * every stage even though only one of them is on the critical path.
 *
 * Re-measured 2026-08-24 on an M3 (8 cores, only 4 of them performance) with a
 * warm cache. Numbers here had drifted badly enough to misdirect work, so keep
 * them current:
 *
 *   concurrency  1 -> 19.4s   2 -> 13.6s   3 -> 13.1s   4 -> 11.9s   6 -> 13.0s
 *
 * 4 is still the knee, but the margin over 2 is ~1.7s, not the 2x once recorded
 * here. Concurrency is BOUNDED on purpose: biome, tsc, knip and wrangler are all
 * internally multi-threaded and `typecheck` / `types:check` are already
 * `pnpm -r --parallel`, so an unbounded pool just oversubscribes four P-cores.
 * Override with `CHECK_CONCURRENCY=n` to re-measure on different hardware.
 *
 * Individual warm gate costs, uncontended, same machine and date:
 *
 *   typecheck 1.7s (9.2s with every tsbuildinfo deleted) · biome 1.2s
 *   dedupe:check 8.3s · knip 4.0s · conventions 1.0s
 *
 * The old "typecheck goes 7s warm to 43s cold" figure predates the native Go
 * tsc and is off by ~5x; see apps/web/tsconfig.json for the same warning.
 * `dedupe:check` remains the noisiest gate (8s here, 29-90s historically, and
 * `--offline` only saves ~1s so it is not the registry) — compare runs in pairs
 * rather than trusting any single number.
 *
 * Gates are ordered longest-first: with a bounded pool, starting the long pole
 * first is what keeps total wall clock at roughly its duration.
 *
 * Gates carrying `triggers` are SKIPPED when nothing in the current change
 * touches their inputs. Measured over the last 100 commits: `openapi:check`
 * inputs moved in 1, `types:check` in 2, `dedupe:check` in 17 — against 86 for
 * `apps/web/src`, which is why the code gates stay unconditional. Skipping the
 * three buys back ~16s of the ~34s serial sum on a typical commit. This is a
 * LOCAL-only narrowing: `CI=1` (and `CHECK_ALL=1`) force every gate, so CI's
 * `lint-format` job still validates exactly what it always did.
 */
import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Gate = {
  /** Label shown in the progress output. */
  name: string;
  command: string;
  args: string[];
  /** Cold-run seconds. Ordering only — cold is the case worth optimising. */
  weight: number;
  /**
   * Paths whose change can make this gate fail. Omit for gates that validate
   * source code itself (those must always run). A bare name matches that
   * basename anywhere (`package.json`); a trailing slash matches a directory
   * prefix (`apps/usda-api/`).
   */
  triggers?: string[];
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const GATES: Gate[] = [
  { name: "typecheck", command: "pnpm", args: ["typecheck"], weight: 43 },
  {
    name: "dedupe:check",
    command: "pnpm",
    args: ["dedupe:check"],
    weight: 29,
    triggers: ["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml"],
  },
  {
    name: "biome",
    command: "biome",
    args: ["check", "--error-on-warnings"],
    weight: 11,
  },
  { name: "knip", command: "pnpm", args: ["knip"], weight: 7 },
  {
    name: "types:check",
    command: "pnpm",
    args: ["types:check"],
    weight: 5,
    // `wrangler types --check` regenerates the committed binding types, so it
    // can only disagree when a worker config, its example env file, or the
    // generated file itself moves.
    triggers: [
      "wrangler.jsonc",
      "wrangler.json",
      "wrangler.toml",
      ".env.example",
      ".dev.vars.example",
      "worker-configuration.d.ts",
    ],
  },
  {
    name: "typecheck:scripts",
    command: "tsc",
    args: ["--noEmit", "-p", "tsconfig.json"],
    weight: 4,
  },
  {
    name: "openapi:check",
    command: "pnpm",
    args: ["openapi:check"],
    weight: 2,
    triggers: ["apps/usda-api/", "packages/usda-contract/", "packages/usda-schemas/"],
  },
  {
    name: "ci-scope",
    command: "node",
    args: ["--test", "scripts/ci-scope.test.ts"],
    weight: 2,
  },
  {
    name: "conventions",
    command: "node",
    args: ["scripts/check-conventions.ts"],
    weight: 2,
  },
  {
    name: "soft-delete-filters",
    command: "node",
    args: ["scripts/check-soft-delete-filters.ts"],
    weight: 2,
  },
];

type Result = {
  gate: Gate;
  code: number;
  output: string;
  seconds: number;
};

/**
 * Every path this working copy has touched relative to the base branch, or
 * `null` when that cannot be determined.
 *
 * `null` means "run everything" — the same fail-safe `scripts/ci-scope.ts`
 * uses. Anything unexpected (detached HEAD, no base ref, git not on PATH, a
 * fresh worktree whose base is missing) must widen the run, never narrow it,
 * because a skipped gate is a silently unvalidated one.
 *
 * Both halves matter: the merge-base diff catches work already committed on the
 * branch, and `status --porcelain` catches what is still staged or unstaged.
 */
function changedPaths(): Set<string> | null {
  const git = (args: string[]): string | null => {
    const out = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.status === 0 ? out.stdout : null;
  };

  const base = ["main", "origin/main"]
    .map((ref) => git(["merge-base", "HEAD", ref])?.trim())
    .find((sha) => sha);
  if (!base) return null;

  const committed = git(["diff", "--name-only", `${base}...HEAD`]);
  const working = git(["status", "--porcelain"]);
  if (committed === null || working === null) return null;

  const paths = new Set(committed.split("\n").filter(Boolean));
  for (const line of working.split("\n").filter(Boolean)) {
    // "XY path", or "XY old -> new" for renames; the destination is what counts.
    const path = line.slice(3);
    paths.add(path.split(" -> ").at(-1) ?? path);
  }
  return paths;
}

/** @see Gate.triggers for the matching rules. */
function isTriggered(gate: Gate, changed: Set<string> | null): boolean {
  if (!gate.triggers) return true;
  if (changed === null) return true;
  return [...changed].some((path) =>
    gate.triggers?.some((trigger) =>
      trigger.endsWith("/")
        ? path.startsWith(trigger)
        : path === trigger || path.endsWith(`/${trigger}`),
    ),
  );
}

/**
 * `biome` and `tsc` live in the root `node_modules/.bin`, which pnpm puts on
 * PATH for its own scripts but not for a bare `node scripts/run-checks.ts`.
 * Prepending it keeps both entry points working.
 */
function childEnv(): NodeJS.ProcessEnv {
  const bin = join(repoRoot, "node_modules/.bin");
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

function runGate(gate: Gate): Promise<Result> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const child = spawn(gate.command, gate.args, {
      cwd: repoRoot,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        gate,
        code: 1,
        output: `${output}\nfailed to spawn ${gate.command}: ${error.message}`,
        seconds: (performance.now() - startedAt) / 1000,
      });
    });
    child.on("close", (code) => {
      resolve({
        gate,
        code: code ?? 1,
        output,
        seconds: (performance.now() - startedAt) / 1000,
      });
    });
  });
}

async function runAll(concurrency: number, gates: Gate[]): Promise<Result[]> {
  const queue = [...gates].sort((a, b) => b.weight - a.weight);
  const results: Result[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < queue.length) {
      const gate = queue[next++];
      if (!gate) return;
      const result = await runGate(gate);
      results.push(result);
      const mark = result.code === 0 ? "PASS" : "FAIL";
      process.stderr.write(
        `  ${mark}  ${result.gate.name} (${result.seconds.toFixed(1)}s)\n`,
      );
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return results;
}

const concurrency = Number(
  process.env.CHECK_CONCURRENCY ?? Math.max(2, Math.min(4, availableParallelism() - 2)),
);

// CI validates the whole tree, not just this branch's diff, so it never narrows.
// Any truthy `CI` counts, not just GitHub's literal "true" — erring toward
// running everything is the safe direction for an unrecognised environment.
const runEverything =
  (!!process.env.CI && process.env.CI !== "false") ||
  process.env.CHECK_ALL === "1";
const changed = runEverything ? null : changedPaths();
const active = GATES.filter((gate) => isTriggered(gate, changed));
const skipped = GATES.filter((gate) => !active.includes(gate));

const startedAt = performance.now();
process.stderr.write(
  `Running ${active.length} gates, concurrency ${concurrency}\n`,
);
if (skipped.length > 0) {
  process.stderr.write(
    `  SKIP  ${skipped.map((gate) => gate.name).join(", ")} (inputs unchanged; CHECK_ALL=1 to force)\n`,
  );
}

const results = await runAll(concurrency, active);
const wall = (performance.now() - startedAt) / 1000;
const failures = results.filter((result) => result.code !== 0);

for (const failure of failures) {
  process.stderr.write(`\n${"=".repeat(64)}\nFAILED: ${failure.gate.name}\n`);
  process.stderr.write(
    `$ ${failure.gate.command} ${failure.gate.args.join(" ")}\n\n`,
  );
  process.stderr.write(`${failure.output.trimEnd()}\n`);
}

const serial = results.reduce((total, result) => total + result.seconds, 0);
process.stderr.write(
  `\n${failures.length === 0 ? "All gates passed" : `${failures.length} gate(s) failed`}` +
    ` in ${wall.toFixed(1)}s (${serial.toFixed(1)}s serial)\n`,
);

if (failures.length > 0) process.exit(1);
