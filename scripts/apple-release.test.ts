import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BUILD_NUMBER_OFFSET,
  commitExists,
  checkpointTag,
  decide,
  newerRunThatBegan,
  readCheckpoint,
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
  previousVersion: "3.1.0",
  pushedVersion: "3.1.0",
  sha: MAIN,
  version: "3.1.0",
  checkpoint: checkpoint(),
  baselineAvailable: true,
  now,
  ...overrides,
});

// Synthetic GitHub REST API: a path → JSON map. Any unmapped path fails
// like a permission error would.
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const fakeGitHub = (routes: Record<string, Json>): GitHub => ({
  get: async <T>(route: string) => {
    const body = routes[route];
    if (body === undefined) throw new Error(`GET ${route}: 403 forbidden`);
    return body as T;
  },
});

// A throwaway repository with one synthetic commit.
const withRepository = (
  body: (
    root: string,
    head: string,
    git: (...args: string[]) => string,
  ) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-apple-release-"));
  try {
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          root,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          ...args,
        ],
        { encoding: "utf8" },
      ).trim();
    git("init", "-q");
    writeFileSync(path.join(root, "file.txt"), "synthetic\n");
    git("add", ".");
    git("commit", "-qm", "synthetic");
    body(root, git("rev-parse", "HEAD"), git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

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
  assert.deepEqual(
    decide(facts({ event: "push", version: "3.2.0", pushedVersion: "3.2.0" })),
    {
      action: "publish",
      reason: "compatibility bump",
    },
  );
  assert.deepEqual(decide(facts({ event: "push" })), {
    action: "skip",
    reason: "compatibility version unchanged",
  });
  assert.deepEqual(decide(facts({ version: "3.2.0" })), {
    action: "publish",
    reason: "compatibility bump",
  });
});

test("same-value pushes skip even without upload history", () => {
  for (const overrides of [{ checkpoint: null }, { baselineAvailable: false }])
    assert.deepEqual(decide(facts({ event: "push", ...overrides })), {
      action: "skip",
      reason: "compatibility version unchanged",
    });
});

test("a later main version bump cannot turn a comment-only push into a release", () => {
  assert.deepEqual(decide(facts({ event: "push", version: "3.2.0" })), {
    action: "skip",
    reason: "compatibility version unchanged",
  });
});

test("the highest-build checkpoint tag wins; no tag is missing history", () => {
  withRepository((root, head, git) => {
    assert.equal(readCheckpoint(root), null);
    const tag = (upload: Checkpoint) =>
      git(
        "tag",
        "-a",
        checkpointTag(upload),
        "-m",
        JSON.stringify(upload),
        upload.sha,
      );
    const older = checkpoint({ sha: head, build: BUILD_NUMBER_OFFSET + 9 });
    const newest = checkpoint({ sha: head, build: BUILD_NUMBER_OFFSET + 10 });
    tag(newest);
    tag(older);
    // Numeric, not lexical: build 10 outranks build 9.
    assert.deepEqual(readCheckpoint(root), newest);
  });
});

test("lightweight, malformed, or mismatched checkpoint tags fail", () => {
  const cases: [string, (head: string) => string[], RegExp][] = [
    ["lightweight", () => ["tag", "testflight/3.1.0-10007"], /not annotated/u],
    [
      "unnumbered",
      () => ["tag", "-a", "testflight/next", "-m", "{}"],
      /names no build/u,
    ],
    [
      "malformed",
      (head) => [
        "tag",
        "-a",
        checkpointTag(checkpoint()),
        "-m",
        JSON.stringify({ ...checkpoint({ sha: head }), version: "3.1" }),
      ],
      /malformed/u,
    ],
    [
      "renamed",
      (head) => [
        "tag",
        "-a",
        "testflight/3.1.0-10008",
        "-m",
        JSON.stringify(checkpoint({ sha: head })),
      ],
      /malformed/u,
    ],
    [
      "retargeted",
      () => [
        "tag",
        "-a",
        checkpointTag(checkpoint()),
        "-m",
        JSON.stringify(checkpoint()),
      ],
      /points away/u,
    ],
  ];
  for (const [label, args, error] of cases)
    withRepository((root, head, git) => {
      git(...args(head));
      assert.throws(() => readCheckpoint(root), error, label);
    });
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
  withRepository((root, head) => {
    assert.equal(commitExists(root, head), true);
    assert.equal(commitExists(root, "d".repeat(40)), false);
  });
});
