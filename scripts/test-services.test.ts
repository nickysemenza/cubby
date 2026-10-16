import { existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import {
  templateMarkerDirectory,
  retireTemplateMarkers,
} from "./lib/template-markers.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { removablePairContainers } from "./test-services.ts";

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
