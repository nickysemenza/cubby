/**
 * Concurrent runner for `pnpm check`.
 *
 * The gates were strictly serial (`a && b && c && …`), which cost the sum of
 * every stage even though only one of them is on the critical path. Measured
 * 2026-08-22 on a warm cache: **~57s serial vs ~27s at concurrency 4**, a 2.1x
 * cut. Cold (fresh worktree, no tsbuildinfo) the serial number is far worse —
 * `pnpm typecheck` alone goes 7s warm to 43s cold.
 *
 * `dedupe:check` is by far the noisiest gate (measured 29s to 90s run to run),
 * so compare runs in pairs rather than trusting any single number.
 *
 * Concurrency is BOUNDED on purpose. Biome, tsc, knip and wrangler are all
 * CPU-hungry, and `typecheck` / `types:check` are already internally parallel
 * (`pnpm -r --parallel`), so launching all ten at once oversubscribes the box
 * and can be slower than a small pool. Measured: concurrency 2 was no better
 * than 4, and 6 and 10 were no better still — 4 is the knee. Override with
 * `CHECK_CONCURRENCY=n` to re-measure on different hardware.
 *
 * Gates are ordered longest-first: with a bounded pool, starting the long pole
 * (`typecheck`) first is what keeps total wall clock at roughly its duration.
 *
 * Every gate that ran before still runs here — `check` remains the single
 * canonical command named in CLAUDE.md, README, and CI's `lint-format` job.
 * Nothing was moved to a CI-only tier: with the pool, `dedupe:check` (29s)
 * finishes inside `typecheck`'s 43s shadow, so dropping it would buy no wall
 * clock while silently narrowing what CI validates.
 */
import { spawn } from "node:child_process";
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
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const GATES: Gate[] = [
  { name: "typecheck", command: "pnpm", args: ["typecheck"], weight: 43 },
  { name: "dedupe:check", command: "pnpm", args: ["dedupe:check"], weight: 29 },
  {
    name: "biome",
    command: "biome",
    args: ["check", "--error-on-warnings"],
    weight: 11,
  },
  { name: "knip", command: "pnpm", args: ["knip"], weight: 7 },
  { name: "types:check", command: "pnpm", args: ["types:check"], weight: 5 },
  {
    name: "typecheck:scripts",
    command: "tsc",
    args: ["--noEmit", "-p", "tsconfig.json"],
    weight: 4,
  },
  { name: "openapi:check", command: "pnpm", args: ["openapi:check"], weight: 2 },
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

async function runAll(concurrency: number): Promise<Result[]> {
  const queue = [...GATES].sort((a, b) => b.weight - a.weight);
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

const startedAt = performance.now();
process.stderr.write(
  `Running ${GATES.length} gates, concurrency ${concurrency}\n`,
);

const results = await runAll(concurrency);
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
