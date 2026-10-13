#!/usr/bin/env node
// Decides whether Apple TestFlight publishes current main, and guards an
// upload against an out-of-order run. Read-only: it inspects git and the
// GitHub API and prints its decision. Node builtins only, so the macOS
// release jobs run `guard` without installing dependencies.
//
//   node scripts/apple-release.ts plan    decide; write GITHUB_OUTPUT
//   node scripts/apple-release.ts guard   fail if a newer run already began
//
// Locally: GITHUB_TOKEN="$(gh auth token)" GITHUB_REPOSITORY=<owner/repo>
// node scripts/apple-release.ts plan (inspected as a nightly run).
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

import { APPLE_CLIENT_COMPATIBILITY_VERSION } from "../packages/shared/src/apple-client-version.ts";

// Build numbers are this plus the workflow's run_number, shared by both
// platforms. Mac build numbers must keep increasing; the offset sits above the
// latest build App Store Connect listed for either platform (2815.1, from the
// retired `<commit count>.<attempt>` scheme) when this numbering began.
export const BUILD_NUMBER_OFFSET = 10000;
const WORKFLOW_PATH = ".github/workflows/apple-testflight.yaml";
const CHECKPOINT_TAG_PREFIX = "testflight/";
const REFRESH_DAYS = 30;
const PAGE = 100;

export type Checkpoint = {
  sha: string;
  version: string;
  build: number;
  uploadedAt: string;
};
export type GitHub = {
  // Resolves to the documented GitHub REST response shape for `route`.
  get: <T>(route: string) => Promise<T>;
};
type Decision =
  | { action: "publish" | "skip"; reason: string }
  | { action: "compare"; base: string };

const versionPattern = /^\d+\.\d+\.\d+$/u;

export function refuseUnsafeRun(run: { ref: string; runAttempt: number }) {
  if (run.ref !== "refs/heads/main")
    throw new Error(
      `Apple releases run only from main; this run is on ${run.ref}.`,
    );
  // A rerun keeps its run_number, which a newer run may already have exceeded.
  if (run.runAttempt !== 1)
    throw new Error(
      `Rerun attempt ${run.runAttempt} refused; dispatch a fresh run of current main instead.`,
    );
}

export function decide(facts: {
  event: string;
  previousVersion?: string | null;
  pushedVersion?: string | null;
  sha: string;
  version: string;
  checkpoint: Checkpoint | null;
  baselineAvailable: boolean;
  now: Date;
}): Decision {
  const { checkpoint } = facts;
  if (facts.event === "workflow_dispatch")
    return { action: "publish", reason: "manual request" };
  if (facts.event === "push") {
    if (facts.previousVersion === undefined || !facts.pushedVersion)
      throw new Error(
        "A push requires its before and after compatibility versions.",
      );
    return facts.pushedVersion !== facts.previousVersion
      ? { action: "publish", reason: "compatibility bump" }
      : { action: "skip", reason: "compatibility version unchanged" };
  }
  if (checkpoint === null || !facts.baselineAvailable)
    return { action: "publish", reason: "missing upload checkpoint" };
  if (facts.version !== checkpoint.version)
    return { action: "publish", reason: "compatibility bump" };
  const age = facts.now.getTime() - Date.parse(checkpoint.uploadedAt);
  if (age >= REFRESH_DAYS * 86_400_000)
    return { action: "publish", reason: "30-day refresh" };
  if (facts.sha === checkpoint.sha)
    return { action: "skip", reason: "main is the uploaded commit" };
  // apple-testflight.yaml classifies the diff with its full/apple filters.
  return { action: "compare", base: checkpoint.sha };
}

async function* paged<T>(github: GitHub, route: string, key: string) {
  for (let page = 1; ; page += 1) {
    const body = await github.get<Partial<Record<string, T[]>>>(
      `${route}per_page=${PAGE}&page=${page}`,
    );
    const items = body[key] ?? [];
    yield* items;
    if (items.length < PAGE) return;
  }
}

const parseCheckpoint = (tag: string, text: string): Checkpoint => {
  const malformed = new Error(
    `Upload checkpoint tag ${tag} is malformed: ${text}`,
  );
  let fields;
  try {
    fields = JSON.parse(text) ?? {};
  } catch {
    throw malformed;
  }
  const checkpoint: Checkpoint = {
    sha: String(fields.sha),
    version: String(fields.version),
    build: Number.isSafeInteger(fields.build) ? fields.build : Number.NaN,
    uploadedAt: String(fields.uploadedAt),
  };
  if (
    /^[0-9a-f]{40}$/u.test(checkpoint.sha) &&
    versionPattern.test(checkpoint.version) &&
    Number.isSafeInteger(checkpoint.build) &&
    /^\d{4}-\d{2}-\d{2}T/u.test(checkpoint.uploadedAt) &&
    !Number.isNaN(Date.parse(checkpoint.uploadedAt)) &&
    tag === checkpointTag(checkpoint)
  )
    return checkpoint;
  throw malformed;
};

export const checkpointTag = (upload: { version: string; build: number }) =>
  `${CHECKPOINT_TAG_PREFIX}${upload.version}-${upload.build}`;

/**
 * The highest-build upload checkpoint in the checkout, or null when no
 * `testflight/*` tag exists (never uploaded). The checkpoint job writes one
 * immutable annotated tag per complete upload, its message the checkpoint
 * JSON. Malformed evidence throws: it may not be mistaken for missing history.
 */
export function readCheckpoint(cwd: string): Checkpoint | null {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const tags = git("tag", "--list", `${CHECKPOINT_TAG_PREFIX}*`)
    .split("\n")
    .filter(Boolean);
  const build = (tag: string) =>
    Number(/-(\d+)$/u.exec(tag)?.[1] ?? Number.NaN);
  const malformed = tags.find((tag) => Number.isNaN(build(tag)));
  if (malformed !== undefined)
    throw new Error(`Upload checkpoint tag ${malformed} names no build`);
  const tag = tags.sort((a, b) => build(b) - build(a))[0];
  if (tag === undefined) return null;
  if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag")
    throw new Error(`Upload checkpoint tag ${tag} is not annotated`);
  const checkpoint = parseCheckpoint(
    tag,
    git("tag", "--list", "--format=%(contents)", tag),
  );
  if (git("rev-parse", `refs/tags/${tag}^{commit}`) !== checkpoint.sha)
    throw new Error(`Upload checkpoint tag ${tag} points away from its SHA`);
  return checkpoint;
}

/**
 * The run_number of a newer main run of this workflow that has begun, else
 * null. Runs waiting on the concurrency group or a runner have not begun; a
 * run cancelled while pending finishes with no jobs.
 */
export async function newerRunThatBegan(
  github: GitHub,
  workflowId: number,
  runNumber: number,
): Promise<number | null> {
  type Run = { id: number; run_number: number; status: string };
  for await (const run of paged<Run>(
    github,
    `/actions/workflows/${workflowId}/runs?branch=main&`,
    "workflow_runs",
  )) {
    // Runs are listed newest first.
    if (run.run_number <= runNumber) return null;
    if (["requested", "queued", "pending"].includes(run.status)) continue;
    const jobs = await github.get<{ total_count: number }>(
      `/actions/runs/${run.id}/jobs?filter=all&per_page=1`,
    );
    if (jobs.total_count > 0) return run.run_number;
  }
  return null;
}

export const commitExists = (cwd: string, sha: string) => {
  try {
    execFileSync("git", ["-C", cwd, "cat-file", "-e", `${sha}^{commit}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
};

const restGitHub = (repository: string, token: string): GitHub => ({
  get: async (route) => {
    const url = `https://api.github.com/repos/${repository}${route}`;
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok)
      throw new Error(
        `GET ${url}: ${response.status} ${await response.text()}`,
      );
    return JSON.parse(await response.text());
  },
});

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const versionAtCommit = (cwd: string, before: string): string | null => {
  if (!/^[0-9a-f]{40}$/u.test(before))
    throw new Error(`Invalid push base: ${before}`);
  if (before !== "0".repeat(40)) {
    const versionPath = "packages/shared/src/apple-client-version.ts";
    const existed = execFileSync(
      "git",
      ["-C", cwd, "ls-tree", "--name-only", before, "--", versionPath],
      { encoding: "utf8" },
    ).trim();
    // The migration adds this declaration; its first push is a version change.
    if (existed) {
      const source = execFileSync(
        "git",
        ["-C", cwd, "show", `${before}:${versionPath}`],
        { encoding: "utf8" },
      );
      const match =
        /export const APPLE_CLIENT_COMPATIBILITY_VERSION = "(\d+\.\d+\.\d+)";/u.exec(
          source,
        );
      if (!match)
        throw new Error(`Cannot read compatibility version at ${before}`);
      return match[1]!;
    }
  }
  return null;
};

async function main(command: string | undefined) {
  if (command !== "plan" && command !== "guard")
    throw new Error("usage: node scripts/apple-release.ts plan|guard");
  const local = !process.env.GITHUB_ACTIONS;
  const github = restGitHub(
    required("GITHUB_REPOSITORY"),
    process.env.GITHUB_TOKEN || required("GH_TOKEN"),
  );
  const workflow = await github.get<{ id: number }>(
    `/actions/workflows/${path.basename(WORKFLOW_PATH)}`,
  );
  const runNumber = local ? null : Number(required("GITHUB_RUN_NUMBER"));
  if (!local)
    refuseUnsafeRun({
      ref: required("GITHUB_REF"),
      runAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
    });
  if (runNumber !== null) {
    const newer = await newerRunThatBegan(github, workflow.id, runNumber);
    if (newer !== null)
      throw new Error(
        `Run ${newer} already began, so build ${BUILD_NUMBER_OFFSET + runNumber} may be stale; dispatch a fresh run of current main.`,
      );
  }
  if (command === "guard") return;

  if (!versionPattern.test(APPLE_CLIENT_COMPATIBILITY_VERSION))
    throw new Error(
      `APPLE_CLIENT_COMPATIBILITY_VERSION must have three numeric components; got ${APPLE_CLIENT_COMPATIBILITY_VERSION}.`,
    );
  const cwd = process.cwd();
  const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const event = local ? "schedule" : required("GITHUB_EVENT_NAME");
  const previousVersion =
    event === "push" ? versionAtCommit(cwd, required("PUSH_BEFORE")) : null;
  const pushedVersion =
    event === "push" ? versionAtCommit(cwd, required("PUSH_AFTER")) : null;
  const checkpoint = readCheckpoint(cwd);
  const decision = decide({
    event,
    previousVersion,
    pushedVersion,
    sha,
    version: APPLE_CLIENT_COMPATIBILITY_VERSION,
    checkpoint,
    baselineAvailable: checkpoint !== null && commitExists(cwd, checkpoint.sha),
    now: new Date(),
  });
  const outputs = {
    sha,
    version: APPLE_CLIENT_COMPATIBILITY_VERSION,
    build: runNumber === null ? "" : String(BUILD_NUMBER_OFFSET + runNumber),
    action: decision.action,
    reason: decision.action === "compare" ? "native changes" : decision.reason,
    base: decision.action === "compare" ? decision.base : "",
  };
  console.log(JSON.stringify({ checkpoint, ...outputs }, null, 2));
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
}

if (import.meta.main) {
  try {
    await main(process.argv[2]);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
