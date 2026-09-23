/**
 * Count failing Playwright tests across recent `ci.yaml` runs, per E2E lane.
 *
 * Browser canaries run with `retries: 0`, so a flake shows up only as a failed
 * "E2E tests (…)" job. This reads those jobs' logs through `gh` and tallies the
 * `##[error]  1) [Project] › tests/e2e/x.ts:13:3 › title` lines the GitHub
 * reporter prints, so the worst offenders are named by evidence, not memory.
 * Shard suffixes (`chromium 1/2`) fold into one lane, since the shard count
 * changes over time.
 *
 * Usage: `node scripts/ci-flakes.ts [--runs 200] [--branch main]`.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "100" },
    branch: { type: "string" },
  },
});
const runLimit = Number(values.runs);
if (!Number.isInteger(runLimit) || runLimit < 1)
  throw new Error("--runs must be a positive integer");

const gh = (args: readonly string[]): string =>
  execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

const failureLine =
  /##\[error\]\s+\d+\) \[([^\]]+)\] › (tests\/e2e\/[^\s:]+:\d+:\d+) › (.+?)\s*$/;
// oxlint-disable-next-line no-control-regex -- ANSI escapes are the input.
const ansi = /\x1b\[[0-9;]*m/g;

function failingTests(log: string): string[] {
  const tests = new Set<string>();
  for (const line of log.replace(ansi, "").split("\n")) {
    const match = failureLine.exec(line);
    if (match) tests.add(`${match[2]} › ${match[3]}`);
  }
  return [...tests];
}

const laneOf = (jobName: string) => jobName.replace(/\s+\d+\/\d+\)$/, ")");

type Run = { databaseId: number; conclusion: string };
type Job = { id: number; name: string; conclusion: string | null };

if (import.meta.main) {
  // SAFETY: `gh --json` returns exactly the fields requested here.
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow",
      "ci.yaml",
      "--limit",
      String(runLimit),
      "--json",
      "databaseId,conclusion",
      ...(values.branch ? ["--branch", values.branch] : []),
    ]),
  ) as Run[];

  const counts = new Map<string, number>();
  const laneFailures = new Map<string, number>();
  let failedRuns = 0;
  let unattributedJobs = 0;
  for (const run of runs.filter((r) => r.conclusion === "failure")) {
    failedRuns += 1;
    // SAFETY: the Actions jobs API documents id, name, and conclusion.
    const jobs = JSON.parse(
      gh([
        "api",
        `repos/{owner}/{repo}/actions/runs/${run.databaseId}/jobs?per_page=100`,
        "--jq",
        ".jobs",
      ]),
    ) as Job[];
    for (const job of jobs) {
      if (job.conclusion !== "failure" || !job.name.startsWith("E2E tests"))
        continue;
      // The aggregate chromium check runs no tests; its shards are counted.
      if (job.name === "E2E tests (chromium)") continue;
      const lane = laneOf(job.name);
      laneFailures.set(lane, (laneFailures.get(lane) ?? 0) + 1);
      let log: string;
      try {
        log = gh([
          "api",
          "--allow-escape-sequences",
          `repos/{owner}/{repo}/actions/jobs/${job.id}/logs`,
        ]);
      } catch {
        // Logs expire after the retention window.
        unattributedJobs += 1;
        continue;
      }
      const tests = failingTests(log);
      if (tests.length === 0) unattributedJobs += 1;
      for (const test of tests) {
        const key = `${lane}\t${test}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  for (const [key, count] of rows) {
    const [lane, test] = key.split("\t");
    console.log(`${String(count).padStart(4)}  ${lane}  ${test}`);
  }
  console.log(
    `\n${runs.length} runs scanned, ${failedRuns} failed; ` +
      [...laneFailures]
        .map(([lane, count]) => `${lane}: ${count} failed jobs`)
        .join(", ") +
      `; ${unattributedJobs} failed jobs without a test failure line` +
      ` (setup error or expired log); ${rows.reduce((n, [, c]) => n + c, 0)} test failures.`,
  );
}
