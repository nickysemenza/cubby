import {
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { hostname, tmpdir } from "node:os";
import {
  templateMarkerDirectory,
  retireTemplateMarkers,
} from "./lib/template-markers.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import assert from "node:assert/strict";
import test from "node:test";

import {
  removablePairContainers,
  liveRuns,
  writeRunRecord,
} from "./test-services.ts";

// Failure modes: every worktree's runs share one pair, so removing a pair a
// live run uses fails that run mid-suite, and matching too broadly deletes the
// dev database, a legacy warm pair, or an unrelated container.
const containers = [
  "cubby-test-aaaaaaaa-postgres",
  "cubby-test-aaaaaaaa-integresql",
  "cubby-test-bbbbbbbb-postgres",
  "cubby-test-bbbbbbbb-integresql",
  "cubby-test-cccccccc-postgres",
  "cubby-dev-pg",
  "cubby-test-pg",
  "cubby-test-integresql",
  "cubby-4242-aabbccdd-postgres",
  "buildkit",
];

test("startup removes only idle pairs of another configuration", () => {
  assert.deepEqual(
    removablePairContainers(
      containers,
      [{ configuration: "bbbbbbbb" }],
      "aaaaaaaa",
    ),
    ["cubby-test-cccccccc-postgres"],
  );
});

test("teardown keeps every pair a live run uses", () => {
  assert.deepEqual(
    removablePairContainers(containers, [{ configuration: "bbbbbbbb" }]),
    [
      "cubby-test-aaaaaaaa-postgres",
      "cubby-test-aaaaaaaa-integresql",
      "cubby-test-cccccccc-postgres",
    ],
  );
});

// Restarted services must not inherit permanent redirects, and cleanup must
// retain the active incarnation and other independently owned services.
test("retires redirects by service incarnation and clears them on teardown", () => {
  const url = `http://synthetic-${process.pid}.example.test:5000`;
  const other = `http://synthetic-other-${process.pid}.example.test:5000`;
  const old = templateMarkerDirectory(url, "synthetic-old-birth");
  const current = templateMarkerDirectory(url, "synthetic-current-birth");
  const unrelated = templateMarkerDirectory(other, "synthetic-other-birth");
  try {
    writeFileSync(`${old}/redirect.json`, "{}");
    retireTemplateMarkers(url, "synthetic-current-birth");
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(current), true);
    assert.equal(existsSync(unrelated), true);
    retireTemplateMarkers(url);
    assert.equal(existsSync(current), false);
  } finally {
    retireTemplateMarkers(url);
    retireTemplateMarkers(other);
  }
});

// A pre-incarnation initializer still owns <service>/<hash>.json. New startup
// must not make its finalization cleanup throw ENOENT and discard the template.
test("startup preserves a live legacy initializer and unverified marker scope", () => {
  const url = `http://synthetic-legacy-${process.pid}.example.test:5000`;
  const current = templateMarkerDirectory(url, "synthetic-current-birth");
  const unknown = templateMarkerDirectory(url);
  const legacy = join(dirname(current), `${"a".repeat(40)}.json`);
  const owner = JSON.stringify({
    pid: process.pid,
    start: "legacy-birth",
    host: hostname(),
  });
  try {
    writeFileSync(legacy, owner);
    writeFileSync(join(unknown, "pending.json"), owner);
    retireTemplateMarkers(url, "synthetic-current-birth");
    assert.equal(readFileSync(legacy, "utf8"), owner);
    assert.equal(readFileSync(join(unknown, "pending.json"), "utf8"), owner);
    // The older initializer can finish its original non-forced cleanup.
    rmSync(legacy);
    retireTemplateMarkers(url);
    assert.equal(existsSync(unknown), true);
  } finally {
    rmSync(dirname(current), { recursive: true, force: true });
  }
});

// A truncated/adoption record must never turn an in-use service into an idle
// one. Unknown owners block lifecycle work; only proven-dead owners are pruned.
test("run records fail closed and prune only proven-dead owners", () => {
  const directory = mkdtempSync(join(tmpdir(), "cubby-run-records-"));
  const file = join(directory, "synthetic.json");
  const owner = {
    pid: process.pid,
    configuration: "aaaaaaaa",
    root: "synthetic",
  };
  try {
    for (const content of ["{", "{}", JSON.stringify({ ...owner, pid: -1 })]) {
      writeFileSync(file, content);
      assert.throws(() => liveRuns(directory), /ownership unknown/u);
      assert.equal(readFileSync(file, "utf8"), content);
    }
    writeFileSync(file, JSON.stringify(owner));
    assert.deepEqual(liveRuns(directory), [owner]);
    writeFileSync(file, JSON.stringify({ ...owner, group: 2147483647 }));
    assert.equal(liveRuns(directory).length, 1);
    writeFileSync(file, JSON.stringify({ ...owner, pid: 2147483647 }));
    assert.deepEqual(liveRuns(directory), []);
    assert.equal(existsSync(file), false);
    writeFileSync(file, JSON.stringify(owner));
    writeFileSync(join(directory, "interrupted.tmp"), "{");
    writeRunRecord(file, { ...owner, group: process.pid });
    assert.deepEqual(liveRuns(directory), [{ ...owner, group: process.pid }]);
    assert.deepEqual(readdirSync(directory).sort(), [
      "interrupted.tmp",
      "synthetic.json",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A killed wrapper can leave its detached command alive; that group still
// protects the service until it too is proven absent.
test("a live command group retains a dead wrapper's run record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cubby-run-group-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  try {
    assert.ok(child.pid);
    const file = join(directory, "synthetic.json");
    writeRunRecord(file, {
      pid: 2147483647,
      group: child.pid,
      configuration: "aaaaaaaa",
      root: "synthetic",
    });
    assert.equal(liveRuns(directory).length, 1);
    const exited = once(child, "exit");
    process.kill(-child.pid, "SIGKILL");
    await exited;
    assert.deepEqual(liveRuns(directory), []);
    assert.equal(existsSync(file), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

// Adoption runs outside the startup lock. Concurrent readers must see a whole
// old or new record, even while the detached command's group is being added.
test("atomic adoption never exposes partial run records to concurrent readers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cubby-run-adoption-"));
  const file = join(directory, "synthetic.json");
  const owner = {
    pid: process.pid,
    configuration: "aaaaaaaa",
    root: "synthetic",
  };
  writeRunRecord(file, owner);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { writeRunRecord } from ${JSON.stringify(new URL("./test-services.ts", import.meta.url).href)};
    for (let i = 0; i < 2000; i++) writeRunRecord(${JSON.stringify(file)}, { ...${JSON.stringify(owner)}, group: i + 1 });
  `,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let error = "";
  child.stderr.on("data", (data) => {
    error += String(data);
  });
  const exited = once(child, "exit");
  try {
    while (child.exitCode === null && child.signalCode === null) {
      assert.equal(liveRuns(directory).length, 1);
      await setImmediate();
    }
    const [code] = await exited;
    assert.equal(code, 0, error);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).group, 2000);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
