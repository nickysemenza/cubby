import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const {
  GITHUB_REPOSITORY: repository,
  GITHUB_RUN_ID: run,
  GITHUB_RUN_ATTEMPT: attempt,
  GITHUB_STEP_SUMMARY: summary,
} = process.env;
if (!repository || !run || !attempt || !summary)
  throw new Error("CI summary requires the GitHub Actions run context");
const response = JSON.parse(
  execFileSync(
    "gh",
    [
      "api",
      `repos/${repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`,
    ],
    { encoding: "utf8" },
  ),
);
if (!Array.isArray(response.jobs))
  throw new Error("Missing Actions job metadata");
const seconds = (start: string, end: string) =>
  Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
const rows: string[] = [];
for (const job of response.jobs) {
  if (job.conclusion === "skipped" || !job.started_at || !job.created_at)
    continue;
  const queue = seconds(job.created_at, job.started_at);
  const duration = job.completed_at
    ? seconds(job.started_at, job.completed_at)
    : "running";
  const setup = Array.isArray(job.steps)
    ? job.steps
        .filter(
          (step: {
            name: string;
            started_at?: string;
            completed_at?: string;
          }) =>
            /setup-node-with-deps|setup-apple|Initialize containers/u.test(
              step.name,
            ) &&
            step.started_at &&
            step.completed_at,
        )
        .reduce(
          (total: number, step: { started_at: string; completed_at: string }) =>
            total + seconds(step.started_at, step.completed_at),
          0,
        )
    : 0;
  rows.push(
    `| ${job.name} | ${job.conclusion ?? job.status} | ${queue} | ${setup} | ${duration} |`,
  );
}
appendFileSync(
  summary,
  [
    "### CI capacity",
    "",
    "Created-to-start includes deliberate concurrency waiting; setup is included in job duration. Nx logs report actual task cache hits separately.",
    "",
    "| Job | Result | Created→start (s) | Setup (s) | Job duration (s) |",
    "| --- | --- | ---: | ---: | ---: |",
    ...rows,
    "",
  ].join("\n"),
);
