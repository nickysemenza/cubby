import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import {
  assessBoatResults,
  pilotEvidenceStatus,
  pilotJobs,
  selectPilotExecutor,
} from "./boat-ci.ts";

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
    { FAKE_ONE_SLOT: "1", BOAT_MACHINES: "2" },
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
    assert.equal(existsSync(path.join(fixture.root, "collected")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fakeBoatFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-boat-regression-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init");
  writeFileSync(
    path.join(root, ".gitignore"),
    "/bin/\n/artifacts/\n/created\n/collected\n/manifest.json\n/deleted\n/summary\n/output\n",
  );
  git("add", ".gitignore");
  git(
    "-c",
    "user.name=Synthetic CI",
    "-c",
    "user.email=ci@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "test: synthetic source revision",
  );
  const executable = path.join(bin, "boat");
  writeFileSync(
    executable,
    `#!${process.execPath}
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root = process.env.FAKE_BOAT_ROOT;
const args = process.argv.slice(2);
const log = (value) => console.log(JSON.stringify(value));
if (args[0] === 'limits') log({canStart: process.env.FAKE_NO_CAPACITY !== '1', creditBalanceSeconds: 1000, maxActiveSandboxes: 2, activeSandboxes: process.env.FAKE_ONE_SLOT==='1'?1:0});
else if (args[0] === 'new') { writeFileSync(path.join(root, 'created'), 'yes'); log({event:'ready',id:'bx_synthetic'}); }
else if (args[0] === 'exec') {
  if (!args.includes('--json')) process.exit(3);
  if (process.env.FAKE_FAILURE === '1') {
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const job = manifest.jobs[0];
    log({type:'stdout',data:'CUBBY_BOAT_RESULT '+JSON.stringify({id:job.id, command:job.run, revision:manifest.revision, tree:manifest.tree, exitCode:1, durationMs:10, sourceClean:true, evidenceComplete:true})+'\\n'});
  }
  if (process.env.FAKE_WAIT === '1') { console.log('FAKE_RUNNING'); setTimeout(() => {}, 30000); }
} else if (args[0] === 'scp' && args[1] === '-r') {
  writeFileSync(path.join(root, 'collected'), 'yes');
  if (process.env.FAKE_SKIP_COLLECTION === '1') process.exit(0);
  if (process.env.FAKE_COLLECTION_FAILURE === '1') process.exit(2);
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  let reports = manifest.jobs.map((job, index) => ({id:job.id, command:job.run, revision:manifest.revision, tree:manifest.tree, exitCode:process.env.FAKE_FAILURE==='1' && index===0 ? 1 : 0, durationMs:10, sourceClean:true, evidenceComplete:true}));
  for (const job of manifest.jobs) {
    const web = path.join(args[3], job.id, 'apps/web');
    mkdirSync(path.join(web, 'playwright-report'), {recursive:true});
    mkdirSync(path.join(web, 'blob-report'), {recursive:true});
    writeFileSync(path.join(web, 'playwright-report/run-manifest.json'), JSON.stringify({status:'passed',source:{commit:manifest.revision,dirty:false},cases:[{status:'passed'}]}));
    writeFileSync(path.join(web, 'blob-report/report.zip'), 'synthetic blob');
    writeFileSync(path.join(web, '.vitest-results.json'), JSON.stringify({success:process.env.FAKE_REPORT_FAILURE!=='1',numTotalTests:1,numFailedTests:process.env.FAKE_REPORT_FAILURE==='1'?1:0}));
  }
  if (process.env.FAKE_MISSING === '1') reports = reports.slice(0, 1);
  writeFileSync(path.join(args[3], 'results.json'), JSON.stringify(reports));
} else if (args[0] === 'scp') writeFileSync(path.join(root, 'manifest.json'), readFileSync(args[1]));
else if (args[0] === 'delete') writeFileSync(path.join(root, 'deleted'), 'yes');
else { console.error('Unexpected fake provider operation', args[0]); process.exit(2); }
`,
  );
  chmodSync(executable, 0o700);
  return {
    root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      BOAT_EXECUTOR: "boat",
      BOAT_CI_ENABLED: "true",
      BOAT_API_KEY: "synthetic-ci-token",
      BOAT_CI_SNAPSHOT: "synthetic-ci-base",
      BOAT_MACHINES: "1",
      BOAT_E2E_SHARDS: "2",
      BOAT_POSTGRES_SHARDS: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_OUTPUT: path.join(root, "output"),
      GITHUB_STEP_SUMMARY: path.join(root, "summary"),
      FAKE_BOAT_ROOT: root,
    },
    script: `import { coordinatePilot } from ${JSON.stringify(new URL("./boat-ci.ts", import.meta.url).href)}; await coordinatePilot(${JSON.stringify(root)});`,
  };
}
