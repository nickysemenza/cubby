import assert from "node:assert/strict";
import { test } from "node:test";

import { laneMatrix, planLanes, selectJourneys } from "./ci-policy.ts";

test("a missing baseline runs every required lane without enabling paid evaluations", () => {
  const plan = planLanes({ event: "pull_request" });
  assert.ok(plan.lanes.includes("e2e"));
  assert.ok(plan.lanes.includes("apple"));
  assert.ok(plan.lanes.includes("rust"));
  assert.deepEqual(plan.optional, []);
});

test("a source-noop reuses a baseline without inventing required jobs", () => {
  const plan = planLanes({
    event: "pull_request",
    baseline: true,
    changes: [],
  });
  assert.deepEqual(plan.matrix, []);
  assert.ok(plan.skips.split(",").includes("lanes"));
});

test("a verified tested tree skips source lanes without requiring another baseline lookup", () => {
  assert.deepEqual(planLanes({ event: "push", tested: true }).lanes, []);
});

test("the tested-tree shortcut is never accepted by a full or fresh run", () => {
  for (const input of [{ full: true }, { fresh: true }]) {
    const plan = planLanes({
      event: "workflow_dispatch",
      tested: true,
      ...input,
    });
    assert.ok(plan.lanes.includes("e2e"));
  }
});

test("a cached nightly still considers all source lanes", () => {
  const plan = planLanes({ event: "schedule", baseline: true, changes: [] });
  assert.ok(plan.lanes.includes("apple"));
  assert.ok(plan.lanes.includes("e2e"));
});

test("web changes do not automatically schedule the informational import browser", () => {
  const plan = planLanes({
    event: "pull_request",
    baseline: true,
    changes: ["e2e", "purchase-import"],
  });
  assert.deepEqual(plan.optional, []);
});

test("relevant import changes and explicit opt-in schedule import without enabling live Email", () => {
  for (const input of [{ purchaseRelevant: true }, { purchaseOptIn: true }]) {
    const plan = planLanes({
      event: "pull_request",
      baseline: true,
      changes: [],
      ...input,
    });
    assert.equal(plan.optional.length, 1);
    assert.equal(plan.optional[0]?.browser, "purchase-import");
  }
});

test("live Email is an explicit manual opt-in", () => {
  assert.deepEqual(
    planLanes({ event: "workflow_dispatch", full: true }).optional,
    [],
  );
  const plan = planLanes({ event: "workflow_dispatch", liveEmail: true });
  assert.equal(plan.optional.length, 1);
  assert.match(plan.optional[0]!.run, /eval:mail-prompts/);
});

test("unknown routing groups fail instead of silently omitting checks", () => {
  assert.throws(
    () =>
      planLanes({ event: "pull_request", baseline: true, changes: ["typo"] }),
    /Unknown lane/,
  );
});

// Pairing must never drop or duplicate a selected check, including partial
// routing without browsers; CI still needs every command after an earlier failure.
test("every routing subset retains each selected command exactly once in at most two jobs", () => {
  const lanes = ["aux", "build-worker", "postgres", "e2e"];
  const commands = Object.fromEntries(
    lanes.map((lane) => [
      lane,
      laneMatrix([lane]).flatMap((entry) => [
        entry.run,
        ...(entry.checks ?? []).map((check) => check.run),
      ]),
    ]),
  );
  for (let mask = 0; mask < 1 << lanes.length; mask++) {
    const selected = lanes.filter((_, index) => mask & (1 << index));
    const matrix = laneMatrix(selected);
    assert.ok(matrix.length <= 2, selected.join(","));
    assert.deepEqual(
      matrix
        .flatMap((entry) => [
          entry.lane,
          ...(entry.checks ?? []).map((check) => check.lane),
        ])
        .sort(),
      selected
        .flatMap((lane) => (lane === "e2e" ? [lane, lane] : [lane]))
        .sort(),
      selected.join(","),
    );
    assert.deepEqual(
      matrix
        .flatMap((entry) => [
          entry.run,
          ...(entry.checks ?? []).map((check) => check.run),
        ])
        .sort(),
      selected.flatMap((lane) => commands[lane]!).sort(),
      selected.join(","),
    );
    for (const entry of matrix) {
      assert.ok((entry.checks?.length ?? 0) <= 2);
      if (
        entry.browser ||
        entry.lane === "postgres" ||
        entry.lane === "build-worker" ||
        entry.checks?.some(
          (check) => check.lane === "build-worker" || check.lane === "postgres",
        )
      )
        assert.equal(entry.db, true);
    }
  }
});

test("combined routing groups keep browser shards and companion checks independently addressable", () => {
  const plan = planLanes({
    event: "pull_request",
    baseline: true,
    changes: ["aux+build-worker.1", "e2e"],
  });
  assert.equal(plan.matrix.filter((entry) => entry.browser).length, 2);
  assert.ok(
    plan.matrix.some(
      (entry) =>
        entry.browser === "desktop-1" &&
        entry.checks?.[0]?.run.includes("run-many -t test") &&
        entry.checks?.[1]?.run.includes("workerd-tests"),
    ),
  );
});

test("a journey dispatch selects its catalog without authorizing a merge gate", () => {
  const plan = selectJourneys({
    journey: "tester-army-all",
    action: "",
    labels: [],
  });
  assert.equal(plan.mode, "journeys");
  assert.equal(plan.web.length, 2);
  assert.equal(plan.ios, true);
});

test("normal PR updates retain labeled journeys and normal CI", () => {
  const plan = selectJourneys({
    journey: "",
    action: "synchronize",
    labels: ["tester-army", "simulator-e2e"],
  });
  assert.equal(plan.mode, "ci");
  assert.equal(plan.web.length, 1);
  assert.equal(plan.simulator, "search");
});

test("unknown journey requests fail before any work is scheduled", () => {
  assert.throws(
    () => selectJourneys({ journey: "unknown", action: "", labels: [] }),
    /Unknown journey/,
  );
});
