import { existsSync, writeFileSync } from "node:fs";
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
