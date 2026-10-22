/**
 * Writes the combined CI job summary: lane results and durations from the
 * Actions API, then failures, flaky tests and the slowest tests from the
 * merged Vitest records and the merged Playwright JSON report.
 *
 *   node tooling/ci-report/summary.ts <vitest-records.json> <playwright.json>
 *
 * A missing input (a lane that never produced a report) is reported, not
 * fatal: the summary must still render when the gate failed early.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  playwrightRecords,
  playwrightReportSchema,
  type TestRecord,
  testRecordSchema,
} from "./records.ts";

const jobsSchema = z.object({
  jobs: z.array(
    z.object({
      name: z.string(),
      conclusion: z.string().nullable(),
      started_at: z.string(),
      completed_at: z.string().nullable(),
    }),
  ),
});
type Job = z.infer<typeof jobsSchema>["jobs"][number];
const runSchema = z.object({ run_started_at: z.string() });

const [vitestPath, playwrightPath] = process.argv.slice(2);
const env = process.env;
const missing: string[] = [];

function readReport<T>(
  path: string | undefined,
  label: string,
  schema: z.ZodType<T>,
): T | undefined {
  if (path === undefined || !existsSync(path)) {
    missing.push(label);
    return undefined;
  }
  return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}

const vitest = readReport(vitestPath, "Vitest", z.array(testRecordSchema));
const playwright = readReport(
  playwrightPath,
  "Playwright",
  playwrightReportSchema,
);
const records = [
  ...(vitest ?? []),
  ...(playwright ? playwrightRecords(playwright, "apps/web/tests/e2e") : []),
];

async function github<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return undefined;
  const response = await fetch(
    `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}${path}`,
    {
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
      },
    },
  );
  if (!response.ok) {
    missing.push(`Actions API ${path} (HTTP ${response.status})`);
    return undefined;
  }
  return schema.parse(await response.json());
}

const runPath = `/actions/runs/${env.GITHUB_RUN_ID}`;
const run = await github(runPath, runSchema);
const jobs = (
  (
    await github(
      `${runPath}/attempts/${env.GITHUB_RUN_ATTEMPT ?? 1}/jobs?per_page=100`,
      jobsSchema,
    )
  )?.jobs ?? []
).filter((job) => job.name !== env.CUBBY_REPORT_JOB && job.completed_at);

const ms = (job: Job) =>
  Date.parse(job.completed_at ?? job.started_at) - Date.parse(job.started_at);
const minutes = (value: number) => `${(value / 60_000).toFixed(1)} min`;
const seconds = (value: number) => `${(value / 1000).toFixed(1)} s`;
const cell = (value: string) =>
  value.replaceAll("|", "\\|").replaceAll("\n", " ");
const fileLink = (file: string) =>
  env.GITHUB_SERVER_URL && env.GITHUB_SHA
    ? `[\`${file}\`](${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/blob/${env.GITHUB_SHA}/${file})`
    : `\`${file}\``;
const icon = new Map([
  ["success", "✅"],
  ["failure", "❌"],
  ["cancelled", "⛔"],
  ["skipped", "⏭️"],
]);

const failed = records.filter((record) => record.state === "failed");
const flaky = records.filter((record) => record.flaky);
const laneFailed = jobs.some(
  (job) => job.conclusion === "failure" || job.conclusion === "cancelled",
);
const lines: string[] = [];
const lastFinish = Math.max(
  0,
  ...jobs.map((job) => Date.parse(job.completed_at ?? job.started_at)),
);
const wall =
  run && lastFinish ? lastFinish - Date.parse(run.run_started_at) : 0;
lines.push(
  `## ${failed.length > 0 || laneFailed ? "❌" : "✅"} CI tests · ${records.length.toLocaleString("en-US")} tests` +
    (wall > 0 ? ` · ${minutes(wall)} wall clock` : ""),
  "",
);

if (jobs.length > 0) {
  lines.push("| Lane | Result | Duration |", "| --- | :---: | ---: |");
  for (const job of [...jobs].sort((a, b) => ms(b) - ms(a)))
    lines.push(
      `| ${cell(job.name)} | ${icon.get(job.conclusion ?? "") ?? job.conclusion} | ${minutes(ms(job))} |`,
    );
  const balance = (prefix: string) => {
    const shards = jobs.filter((job) => job.name.startsWith(prefix));
    if (shards.length < 2) return [];
    const durations = shards.map(ms);
    const low = Math.min(...durations);
    const high = Math.max(...durations);
    return [
      `${prefix.trim()}: ${minutes(low)}–${minutes(high)} (spread ${minutes(high - low)})`,
    ];
  };
  const shardLines = [...balance("E2E tests "), ...balance("Vitest ")];
  if (shardLines.length > 0)
    lines.push("", `**Shard balance:** ${shardLines.join(" · ")}`);
  lines.push("");
}

lines.push(
  "| Runner | Passed | Failed | Flaky | Skipped | Summed test time |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
);
for (const runner of ["vitest", "playwright"] as const) {
  const own = records.filter((record) => record.runner === runner);
  if (own.length === 0) continue;
  const count = (state: TestRecord["state"]) =>
    own.filter((record) => record.state === state).length;
  lines.push(
    `| ${runner === "vitest" ? "Vitest" : "Playwright"} | ${count("passed")} | ${count("failed")} | ${own.filter((record) => record.flaky).length} | ${count("skipped")} | ${minutes(own.reduce((sum, record) => sum + record.durationMs, 0))} |`,
  );
}
lines.push("");

const list = (title: string, items: TestRecord[], limit: number) => {
  if (items.length === 0) return;
  lines.push(`### ${title} (${items.length})`, "");
  for (const record of items.slice(0, limit)) {
    const error = record.error?.split("\n")[0]?.slice(0, 200);
    lines.push(
      `- ${fileLink(record.file)} › ${cell(record.name)} _(${record.project})_` +
        (error ? `\n  > ${cell(error)}` : ""),
    );
  }
  if (items.length > limit) lines.push(`- …and ${items.length - limit} more`);
  lines.push("");
};
list("❌ Failures", failed, 25);
list("⚠️ Flaky: failed, then passed on retry", flaky, 25);

const slowest = records
  .filter((record) => record.state !== "skipped")
  .sort((a, b) => b.durationMs - a.durationMs)
  .slice(0, 15);
if (slowest.length > 0) {
  lines.push(
    "<details><summary>🐢 Slowest tests</summary>",
    "",
    "| Duration | Runner | Test | File |",
    "| ---: | --- | --- | --- |",
    ...slowest.map(
      (record) =>
        `| ${seconds(record.durationMs)} | ${record.runner} (${record.project}) | ${cell(record.name)} | ${fileLink(record.file)} |`,
    ),
    "",
    "</details>",
    "",
  );
}

const reports = [
  env.CUBBY_VITEST_REPORT_URL &&
    `[Vitest](https://viewer.vitest.dev/?url=${env.CUBBY_VITEST_REPORT_URL})`,
  env.CUBBY_PLAYWRIGHT_REPORT_URL &&
    `[Playwright](${env.CUBBY_PLAYWRIGHT_REPORT_URL}) (unzip, then \`pnpm --dir apps/web exec playwright show-report <dir>\`)`,
].filter(Boolean);
if (reports.length > 0)
  lines.push(`**Merged HTML reports:** ${reports.join(" · ")}`, "");
if (missing.length > 0)
  lines.push(`_Not available: ${missing.join(", ")}._`, "");

const markdown = lines.join("\n");
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
else process.stdout.write(markdown);
