import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  assessBoatResults,
  pilotJobs,
  selectPilotExecutor,
} from "./boat-ci.ts";
import { fakeBoatFixture } from "./boat-ci.fixtures.ts";
import { pilotEvidenceStatus } from "./boat-ci-evidence.ts";

const revision = "a".repeat(40);
const tree = "b".repeat(40);
const jobs = pilotJobs(["e2e", "postgres", "aux", "build-worker"], 2, 1);
const reports = () =>
  jobs.map((job) => ({
    id: job.id,
    revision,
    tree,
    command: job.run,
    exitCode: 0,
    durationMs: 100,
    sourceClean: true,
    evidenceComplete: true,
  }));

// The coordinator sees an external provider response, not a trusted exit code:
// missing/mismatched evidence cannot bypass all or part of the selected work.
test("every selected task and companion has exact-revision evidence", () => {
  assert.equal(jobs.length, 5);
  assert.equal(assessBoatResults(jobs, reports(), revision, tree), "passed");
  assert.equal(
    assessBoatResults(jobs, reports().slice(1), revision, tree),
    "fallback",
  );
  for (const mismatch of [
    { revision: "c".repeat(40) },
    { tree: "d".repeat(40) },
    { command: "true" },
  ]) {
    const evidence = reports();
    Object.assign(evidence[0]!, mismatch);
    assert.equal(assessBoatResults(jobs, evidence, revision, tree), "fallback");
  }
});

test("a known test failure survives another machine losing its report", () => {
  const evidence = reports().slice(1);
  evidence[0]!.exitCode = 1;
  assert.equal(assessBoatResults(jobs, evidence, revision, tree), "failed");
});

test("a test timeout is a failure rather than a provider retry", () => {
  const evidence = reports();
  evidence[0]!.exitCode = 124;
  assert.equal(assessBoatResults(jobs, evidence, revision, tree), "failed");
});

test("source changes during execution fail rather than certify the original revision", () => {
  const evidence = reports();
  evidence[0]!.sourceClean = false;
  assert.equal(assessBoatResults(jobs, evidence, revision, tree), "failed");
});

test("explicit report failure is sticky even when the command returned zero", () => {
  const evidence = reports();
  Object.assign(evidence[0]!, {
    evidenceComplete: false,
    evidenceFailed: true,
  });
  assert.equal(assessBoatResults(jobs, evidence, revision, tree), "failed");
});

test("missing task diagnostics cannot certify a successful command", () => {
  const evidence = reports();
  evidence[0]!.evidenceComplete = false;
  assert.equal(assessBoatResults(jobs, evidence, revision, tree), "fallback");
});

test("duplicate or unselected shard evidence cannot establish completion", () => {
  assert.equal(
    assessBoatResults(jobs, [...reports(), reports()[0]!], revision, tree),
    "fallback",
  );
  assert.equal(
    assessBoatResults(
      jobs,
      [...reports(), { ...reports()[0]!, id: "unselected" }],
      revision,
      tree,
    ),
    "fallback",
  );
});

test("a non-exit or invalid timing is not a passing task", () => {
  for (const mismatch of [
    { exitCode: null },
    { exitCode: -1 },
    { durationMs: -1 },
  ]) {
    const evidence = reports();
    Object.assign(evidence[0]!, mismatch);
    assert.equal(assessBoatResults(jobs, evidence, revision, tree), "fallback");
  }
});

test("collected browser and database diagnostics must be present, passing and current", () => {
  const fixture = fakeBoatFixture();
  try {
    const browser = jobs.find((job) => job.browser)!;
    const postgres = jobs.find((job) => job.id === "postgres-1")!;
    const web = path.join(fixture.root, "apps/web");
    mkdirSync(path.join(web, "playwright-report"), { recursive: true });
    mkdirSync(path.join(web, "blob-report"), { recursive: true });
    assert.equal(
      pilotEvidenceStatus(fixture.root, browser, revision),
      "missing",
    );
    const manifest = {
      status: "passed",
      source: { commit: revision, dirty: false },
      cases: [{ status: "passed" }],
    };
    const file = path.join(web, "playwright-report/run-manifest.json");
    writeFileSync(file, JSON.stringify(manifest));
    assert.equal(
      pilotEvidenceStatus(fixture.root, browser, revision),
      "missing",
    );
    writeFileSync(path.join(web, "blob-report/report.zip"), "synthetic report");
    assert.equal(
      pilotEvidenceStatus(fixture.root, browser, revision),
      "passed",
    );
    writeFileSync(
      file,
      JSON.stringify({ ...manifest, cases: [{ status: "failed" }] }),
    );
    assert.equal(
      pilotEvidenceStatus(fixture.root, browser, revision),
      "passed",
    );
    assert.equal(pilotEvidenceStatus(fixture.root, browser, tree), "missing");
    writeFileSync(file, JSON.stringify({ ...manifest, status: "failed" }));
    assert.equal(
      pilotEvidenceStatus(fixture.root, browser, revision),
      "failed",
    );
    const json = path.join(web, ".vitest-results.json");
    assert.equal(
      pilotEvidenceStatus(fixture.root, postgres, revision),
      "missing",
    );
    writeFileSync(
      json,
      JSON.stringify({ success: true, numTotalTests: 3, numFailedTests: 0 }),
    );
    assert.equal(
      pilotEvidenceStatus(fixture.root, postgres, revision),
      "passed",
    );
    writeFileSync(
      json,
      JSON.stringify({ success: true, numTotalTests: 0, numFailedTests: 0 }),
    );
    assert.equal(
      pilotEvidenceStatus(fixture.root, postgres, revision),
      "missing",
    );
    writeFileSync(
      json,
      JSON.stringify({ success: false, numTotalTests: 3, numFailedTests: 1 }),
    );
    assert.equal(
      pilotEvidenceStatus(fixture.root, postgres, revision),
      "failed",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("executor-off and missing credentials select GitHub without contacting Boat", () => {
  assert.equal(selectPilotExecutor("github", true, true), "github");
  assert.equal(selectPilotExecutor("boat", false, true), "github");
  assert.equal(selectPilotExecutor("boat", true, false), "github");
  assert.equal(selectPilotExecutor("boat", true, true), "boat");
});

test("shard counts preserve every lane and cannot create empty coverage", () => {
  assert.throws(() => pilotJobs(["e2e"], 0, 1));
  assert.throws(() => pilotJobs(["postgres"], 2, 0));
  const expanded = pilotJobs(["e2e", "postgres"], 6, 3);
  assert.equal(expanded.length, 9);
  assert.equal(new Set(expanded.map((job) => job.id)).size, 9);
  assert.match(expanded.find((job) => job.id === "e2e-6")!.run, /6\/6/);
  assert.match(expanded.find((job) => job.id === "postgres-3")!.run, /3\/3/);
});

test("provider process boundary preserves failures, collects evidence and deletes machines", async () => {
  for (const scenario of [
    { flags: {}, outcome: "passed", exitCode: 0 },
    { flags: { FAKE_REPORT_FAILURE: "1" }, outcome: "failed", exitCode: 1 },
    { flags: { FAKE_MISSING: "1" }, outcome: "fallback", exitCode: 0 },
    {
      flags: { FAKE_MISSING: "1", FAKE_FAILURE: "1" },
      outcome: "failed",
      exitCode: 1,
    },
    {
      flags: { FAKE_COLLECTION_FAILURE: "1", FAKE_FAILURE: "1" },
      outcome: "failed",
      exitCode: 1,
    },
  ]) {
    const fixture = fakeBoatFixture();
    try {
      let exitCode = 0;
      try {
        await promisify(execFile)(
          process.execPath,
          ["--input-type=module", "-e", fixture.script],
          { env: { ...fixture.env, ...scenario.flags } },
        );
      } catch (error) {
        exitCode = Number((error as { code: number }).code);
      }
      assert.equal(exitCode, scenario.exitCode);
      assert.match(
        readFileSync(path.join(fixture.root, "output"), "utf8"),
        new RegExp(`outcome=${scenario.outcome}`),
      );
      assert.ok(existsSync(path.join(fixture.root, "deleted")));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("a second run cannot reuse diagnostics left by an earlier transfer", async () => {
  const fixture = fakeBoatFixture();
  try {
    const invoke = promisify(execFile);
    await invoke(
      process.execPath,
      ["--input-type=module", "-e", fixture.script],
      { env: fixture.env },
    );
    await invoke(
      process.execPath,
      ["--input-type=module", "-e", fixture.script],
      { env: { ...fixture.env, FAKE_SKIP_COLLECTION: "1" } },
    );
    assert.equal(
      readFileSync(path.join(fixture.root, "output"), "utf8")
        .trim()
        .split("\n")
        .at(-1),
      "outcome=fallback",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("capacity exhaustion and executor-off perform no remote allocations", async () => {
  for (const flags of [
    { FAKE_NO_CAPACITY: "1" },
    { BOAT_CI_ENABLED: "false" },
  ]) {
    const fixture = fakeBoatFixture();
    try {
      await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "-e", fixture.script],
        { env: { ...fixture.env, ...flags } },
      );
      assert.match(
        readFileSync(path.join(fixture.root, "output"), "utf8"),
        /outcome=fallback/,
      );
      assert.equal(existsSync(path.join(fixture.root, "created")), false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("cancellation cleans up without authorizing fallback", async () => {
  const fixture = fakeBoatFixture();
  try {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", fixture.script],
      {
        env: { ...fixture.env, FAKE_WAIT: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (data) => {
      if (String(data).includes("FAKE_RUNNING")) child.kill("SIGTERM");
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    clearTimeout(timer);
    assert.equal(code, 130);
    assert.match(
      readFileSync(path.join(fixture.root, "output"), "utf8"),
      /outcome=cancelled/,
    );
    assert.ok(existsSync(path.join(fixture.root, "deleted")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
