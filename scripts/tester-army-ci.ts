/* oxlint-disable anti-slop/no-runtime-typeof -- GitHub JSON validation must work before dependency installation and after setup failure. */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyTesterArmyChanges } from "./lib/tester-army-routing.ts";

const env = process.env;
async function github(route: string, method = "GET", body?: { body: string }) {
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(
    `${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}/${route}`,
    options,
  );
  if (!response.ok)
    throw new Error(`GitHub ${method} ${route}: ${response.status}`);
  return response.json();
}

const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8"));
if (process.argv[2] === "route") {
  const files: string[] = [];
  if (event.pull_request?.head.repo.full_name === env.GITHUB_REPOSITORY) {
    for (let page = 1; ; page++) {
      const batch = await github(
        `pulls/${event.number}/files?per_page=100&page=${page}`,
      );
      assert(Array.isArray(batch), "Invalid GitHub changed-file list");
      files.push(
        ...batch.flatMap((file) => {
          assert(typeof file.filename === "string", "Invalid GitHub filename");
          assert(
            file.previous_filename === undefined ||
              typeof file.previous_filename === "string",
            "Invalid previous GitHub filename",
          );
          return [
            file.filename,
            ...(file.previous_filename ? [file.previous_filename] : []),
          ];
        }),
      );
      if (batch.length < 100) break;
      if (page === 30)
        throw new Error(
          "PR file list exceeds GitHub's complete-file-list limit",
        );
    }
  }
  for (const [lane, selected] of Object.entries(
    classifyTesterArmyChanges(files),
  ))
    appendFileSync(env.GITHUB_OUTPUT!, `${lane}=${selected}\n`);
} else if (process.argv[2] === "publish") {
  const lane = env.TESTER_ARMY_LANE;
  if (lane !== "web" && lane !== "ios" && lane !== "import")
    throw new Error("TESTER_ARMY_LANE must be web, ios or import");
  const root =
    lane === "ios"
      ? "artifacts/sim-tester-army-e2e"
      : "artifacts/tester-army/web";
  const summaries = existsSync(root)
    ? readdirSync(root).flatMap((run) => {
        const file = path.join(root, run, "agent-summary.json");
        return existsSync(file) ? [JSON.parse(readFileSync(file, "utf8"))] : [];
      })
    : [];
  const head = event.pull_request?.head.sha ?? env.GITHUB_SHA;
  // No-results reporting must survive a failed install without workspace dependencies.
  const { formatTesterArmySummary } = await import(
    summaries.length === 0
      ? "./lib/tester-army-summary.ts"
      : "./lib/tester-army-ci.ts"
  );
  const body = formatTesterArmySummary({
    lane,
    head,
    outcome: env.TESTER_ARMY_JOB_STATUS ?? "failure",
    summaries,
    runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  });
  appendFileSync(env.GITHUB_STEP_SUMMARY!, body);
  if (
    !event.pull_request ||
    event.pull_request.head.repo.full_name !== env.GITHUB_REPOSITORY
  )
    process.exit(0);
  const pr = await github(`pulls/${event.number}`);
  assert(
    pr !== null && typeof pr === "object" && "head" in pr,
    "Invalid GitHub PR",
  );
  assert(
    pr.head !== null && typeof pr.head === "object" && "sha" in pr.head,
    "Invalid GitHub PR head",
  );
  if (pr.head.sha !== head) process.exit(0); // A superseded run must not overwrite the current revision's comment.
  const marker = `<!-- cubby-tester-army:${lane} -->`;
  let found: { id: number } | undefined;
  for (let page = 1; ; page++) {
    const comments = await github(
      `issues/${event.number}/comments?per_page=100&page=${page}`,
    );
    assert(Array.isArray(comments), "Invalid GitHub comment list");
    found = comments.find(
      (comment: { body: string; user: { login: string } }) =>
        comment.user.login === "github-actions[bot]" &&
        comment.body.startsWith(marker),
    );
    if (found)
      assert(Number.isSafeInteger(found.id), "Invalid GitHub comment ID");
    if (found || comments.length < 100) break;
  }
  await github(
    found ? `issues/comments/${found.id}` : `issues/${event.number}/comments`,
    found ? "PATCH" : "POST",
    { body },
  );
} else throw new Error("Usage: tester-army-ci.ts route|publish");
