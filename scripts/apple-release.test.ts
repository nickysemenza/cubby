import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BUILD_NUMBER_OFFSET,
  commitExists,
  decide,
  findCheckpoint,
  newerRunThatBegan,
  refuseUnsafeRun,
  type Checkpoint,
  type GitHub,
} from "./apple-release.ts";

const WORKFLOW_ID = 4242;
const MAIN = "a".repeat(40);
const UPLOADED = "b".repeat(40);
const now = new Date("2026-03-31T10:17:00Z");
const daysAgo = (days: number) =>
  new Date(now.getTime() - days * 86_400_000).toISOString();
const checkpoint = (overrides: Partial<Checkpoint> = {}): Checkpoint => ({
  sha: UPLOADED,
  version: "3.1.0",
  build: BUILD_NUMBER_OFFSET + 7,
  uploadedAt: daysAgo(2),
  ...overrides,
});
const facts = (overrides: Partial<Parameters<typeof decide>[0]> = {}) => ({
  event: "schedule",
  sha: MAIN,
  version: "3.1.0",
  checkpoint: checkpoint(),
  baselineAvailable: true,
  now,
  ...overrides,
});

// Synthetic GitHub REST API: a path → JSON map, plus artifact contents.
// Any unmapped path fails like a permission error would.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const fakeGitHub = (
  routes: Record<string, Json>,
  artifacts: Record<number, string> = {},
): GitHub => ({
  get: async <T>(route: string) => {
    const body = routes[route];
    if (body === undefined) throw new Error(`GET ${route}: 403 forbidden`);
    // SAFETY: each fixture route holds the documented response shape for its path.
    return body as T;
  },
  artifactText: async (id) => {
    const text = artifacts[id];
    if (text === undefined) throw new Error(`artifact ${id}: 410 gone`);
    return text;
  },
});
const artifactsPage = (page: number) =>
  `/actions/artifacts?name=apple-testflight-uploaded&per_page=100&page=${page}`;
const artifact = (
  id: number,
  runId: number,
  createdAt: string,
  expired = false,
) => ({
  id,
  name: "apple-testflight-uploaded",
  expired,
  created_at: createdAt,
  workflow_run: { id: runId },
});
const run = (id: number, overrides: Record<string, string | number> = {}) => ({
  id,
  workflow_id: WORKFLOW_ID,
  path: ".github/workflows/apple-testflight.yaml",
  head_branch: "main",
  ...overrides,
});

test("only a main-branch first attempt may plan or publish", () => {
  assert.throws(
    () => refuseUnsafeRun({ ref: "refs/heads/feature", runAttempt: 1 }),
    /only from main/u,
  );
  assert.throws(
    () => refuseUnsafeRun({ ref: "refs/heads/main", runAttempt: 2 }),
    /fresh/u,
  );
  refuseUnsafeRun({ ref: "refs/heads/main", runAttempt: 1 });
});

test("a manual dispatch publishes current main even when nothing changed", () => {
  assert.deepEqual(
    decide(
      facts({
        event: "workflow_dispatch",
        checkpoint: checkpoint({ sha: MAIN }),
      }),
    ),
    { action: "publish", reason: "manual request" },
  );
});

test("a nightly run compares main against the uploaded SHA, not the previous commit", () => {
  assert.deepEqual(decide(facts()), { action: "compare", base: UPLOADED });
  assert.deepEqual(decide(facts({ checkpoint: checkpoint({ sha: MAIN }) })), {
    action: "skip",
    reason: "main is the uploaded commit",
  });
});

test("an upload 30 days old is refreshed; 29 days is not", () => {
  const stale = checkpoint({ sha: MAIN, uploadedAt: daysAgo(30) });
  assert.deepEqual(decide(facts({ checkpoint: stale })), {
    action: "publish",
    reason: "30-day refresh",
  });
  const fresh = checkpoint({ sha: MAIN, uploadedAt: daysAgo(29) });
  assert.equal(decide(facts({ checkpoint: fresh })).action, "skip");
});

test("missing history rebuilds instead of skipping", () => {
  assert.deepEqual(decide(facts({ checkpoint: null })), {
    action: "publish",
    reason: "missing upload checkpoint",
  });
  assert.deepEqual(decide(facts({ baselineAvailable: false })), {
    action: "publish",
    reason: "missing upload checkpoint",
  });
});

test("a compatibility bump publishes on push; a same-value edit waits for the nightly", () => {
  assert.deepEqual(decide(facts({ event: "push", version: "3.2.0" })), {
    action: "publish",
    reason: "compatibility bump",
  });
  assert.deepEqual(decide(facts({ event: "push" })), {
    action: "skip",
    reason: "compatibility version unchanged",
  });
  assert.deepEqual(decide(facts({ version: "3.2.0" })), {
    action: "publish",
    reason: "compatibility bump",
  });
});

test("the newest authentic checkpoint wins across pages; expired and foreign artifacts never count", async () => {
  const filler = Array.from({ length: 100 }, (_, index) =>
    artifact(1000 + index, 9000, daysAgo(80), true),
  );
  const github = fakeGitHub(
    {
      [artifactsPage(1)]: { artifacts: [...filler] },
      [artifactsPage(2)]: {
        artifacts: [
          artifact(1, 11, daysAgo(10)),
          artifact(2, 12, daysAgo(3)),
          // Uploaded by another workflow or from a non-main dispatch.
          artifact(3, 13, daysAgo(1)),
          artifact(4, 14, daysAgo(1)),
        ],
      },
      "/actions/runs/11": run(11),
      "/actions/runs/12": run(12),
      "/actions/runs/13": run(13, {
        workflow_id: 1,
        path: ".github/workflows/ci.yaml",
      }),
      "/actions/runs/14": run(14, { head_branch: "feature" }),
    },
    {
      1: JSON.stringify(checkpoint({ sha: "c".repeat(40) })),
      2: JSON.stringify(checkpoint()),
    },
  );
  assert.deepEqual(await findCheckpoint(github, WORKFLOW_ID), checkpoint());
});

test("no checkpoint is missing history, but malformed evidence or an API error fails", async () => {
  const empty = fakeGitHub({ [artifactsPage(1)]: { artifacts: [] } });
  assert.equal(await findCheckpoint(empty, WORKFLOW_ID), null);

  const routes = {
    [artifactsPage(1)]: { artifacts: [artifact(2, 12, daysAgo(1))] },
    "/actions/runs/12": run(12),
  };
  const malformed = fakeGitHub(routes, {
    2: JSON.stringify({ ...checkpoint(), version: "3.1" }),
  });
  await assert.rejects(findCheckpoint(malformed, WORKFLOW_ID), /malformed/u);

  await assert.rejects(findCheckpoint(fakeGitHub({}), WORKFLOW_ID), /403/u);
});

test("a higher-numbered run that began blocks an older publisher; pending ones do not", async () => {
  const runsPage = `/actions/workflows/${WORKFLOW_ID}/runs?branch=main&per_page=100&page=1`;
  const runs = (...list: Json[]) => ({ workflow_runs: list });
  const jobs = (id: number, count: number) => ({
    [`/actions/runs/${id}/jobs?filter=all&per_page=1`]: { total_count: count },
  });
  const ours = { id: 20, run_number: 20, status: "in_progress" };

  const pendingOnly = fakeGitHub({
    [runsPage]: runs(
      { id: 22, run_number: 22, status: "pending" },
      { id: 21, run_number: 21, status: "queued" },
      ours,
    ),
  });
  assert.equal(await newerRunThatBegan(pendingOnly, WORKFLOW_ID, 20), null);

  // Cancelled while pending under the concurrency group: it never had jobs.
  const replacedWhilePending = fakeGitHub({
    [runsPage]: runs({ id: 21, run_number: 21, status: "completed" }, ours),
    ...jobs(21, 0),
  });
  assert.equal(
    await newerRunThatBegan(replacedWhilePending, WORKFLOW_ID, 20),
    null,
  );

  // A nightly that skipped still began, so its number is spent.
  const newerSkip = fakeGitHub({
    [runsPage]: runs({ id: 21, run_number: 21, status: "completed" }, ours),
    ...jobs(21, 1),
  });
  assert.equal(await newerRunThatBegan(newerSkip, WORKFLOW_ID, 20), 21);
});

test("a baseline commit absent from the checkout is unavailable history", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-apple-release-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(path.join(root, "file.txt"), "synthetic\n");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "synthetic",
    );
    assert.equal(commitExists(root, git("rev-parse", "HEAD")), true);
    assert.equal(commitExists(root, "d".repeat(40)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
