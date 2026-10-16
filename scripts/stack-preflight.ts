import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const pullSchema = z.object({
  number: z.number(),
  state: z.string(),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  head: z.object({ sha: z.string() }),
});
const stackSchema = z.object({
  pull_requests: z.array(
    z.object({
      number: z.number(),
      head: z.object({ sha: z.string() }),
      base: z.object({ ref: z.string() }),
    }),
  ),
});
const runSchema = z.object({
  id: z.number(),
  event: z.string(),
  status: z.string(),
  head_sha: z.string(),
  pull_requests: z.array(z.object({ number: z.number() })),
});

export function layerProblems(layer: {
  number: number;
  state: string;
  draft: boolean;
  ancestor: boolean;
  mergeable: boolean | null;
  event: string;
  status: string;
  gate: string;
}) {
  const problems: string[] = [];
  if (layer.state !== "open" || layer.draft)
    problems.push("PR is closed or a draft");
  if (!layer.ancestor) problems.push("predecessor/trunk is not an ancestor");
  if (layer.mergeable !== true)
    problems.push("mergeability is blocked or not yet known");
  if (layer.event !== "pull_request")
    problems.push("no normal PR CI run on the current head");
  if (layer.status !== "completed" || layer.gate !== "success")
    problems.push("current required CI has not passed");
  return problems;
}

const api = (path: string) =>
  JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));

function preflight(repository: string, stack: string) {
  if (!/^\d+$/u.test(stack) || !/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error(
      "Usage: pnpm check:stack <stack-number> [owner/repository]",
    );
  const root = `repos/${repository}`;
  const layers = stackSchema.parse(
    api(`${root}/stacks/${stack}`),
  ).pull_requests;
  if (!layers.length) throw new Error("Native stack has no members");
  const trunk = layers[0]!.base.ref;
  let predecessor = z
    .object({ object: z.object({ sha: z.string() }) })
    .parse(api(`${root}/git/ref/heads/${encodeURIComponent(trunk)}`))
    .object.sha;
  const report = [];
  for (const member of layers) {
    const pull = pullSchema.parse(api(`${root}/pulls/${member.number}`));
    const head = pull.head.sha;
    const comparison = z
      .object({ status: z.string() })
      .parse(api(`${root}/compare/${predecessor}...${head}`));
    const runs = z
      .object({ workflow_runs: z.array(runSchema) })
      .parse(
        api(
          `${root}/actions/workflows/ci.yaml/runs?event=pull_request&head_sha=${head}&per_page=20`,
        ),
      ).workflow_runs;
    const run = runs.find(
      (candidate) =>
        candidate.head_sha === head &&
        candidate.pull_requests.some((pr) => pr.number === pull.number),
    );
    const jobs = run
      ? z
          .object({
            jobs: z.array(
              z.object({ name: z.string(), conclusion: z.string().nullable() }),
            ),
          })
          .parse(api(`${root}/actions/runs/${run.id}/jobs?per_page=100`)).jobs
      : [];
    const errors = layerProblems({
      ...pull,
      ancestor: ["ahead", "identical"].includes(comparison.status),
      event: run?.event ?? "",
      status: run?.status ?? "",
      gate: jobs.find((job) => job.name === "CI passed")?.conclusion ?? "",
    });
    if (
      head !== member.head.sha ||
      pullSchema.parse(api(`${root}/pulls/${member.number}`)).head.sha !== head
    )
      errors.push("head changed while checking; rerun preflight");
    report.push({ number: pull.number, head, errors });
    predecessor = head;
  }
  console.log(
    JSON.stringify(
      {
        stack,
        trunk,
        ready: report.every((layer) => layer.errors.length === 0),
        layers: report,
      },
      null,
      2,
    ),
  );
  return report.some((layer) => layer.errors.length > 0) ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stack = process.argv[2] || "";
  if (stack === "--help")
    console.log("Usage: pnpm check:stack <stack-number> [owner/repository]");
  else {
    const remote = process.argv[3]
      ? ""
      : execFileSync("git", ["remote", "get-url", "origin"], {
          encoding: "utf8",
        }).trim();
    const repository =
      process.argv[3] ||
      /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(remote)?.[1] ||
      "";
    process.exitCode = preflight(repository, stack);
  }
}
