import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

export function parseRuns(arguments_: readonly string[]): number {
  if (arguments_.length === 0) return 10;
  const match = /^--runs=(\d+)$/.exec(arguments_[0] ?? "");
  const runs = match ? Number(match[1]) : Number.NaN;
  if (arguments_.length !== 1 || !Number.isInteger(runs) || runs < 1) {
    throw new Error("benchmark-check: expected --runs=<positive integer>");
  }
  return runs;
}

export function summarizeDurations(durations: readonly number[]) {
  const sorted = durations.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return {
    runs: sorted.length,
    minimum: sorted[0] ?? 0,
    median,
    maximum: sorted.at(-1) ?? 0,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

if (import.meta.main) {
  const runs = parseRuns(process.argv.slice(2));
  const durations: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const result = spawnSync("pnpm", ["check"], {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    const elapsed = (performance.now() - started) / 1000;
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
    durations.push(elapsed);
    process.stdout.write(
      `check ${index + 1}/${runs}: ${elapsed.toFixed(2)}s\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(summarizeDurations(durations), undefined, 2)}\n`,
  );
}
