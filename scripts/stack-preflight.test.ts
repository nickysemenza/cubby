import assert from "node:assert/strict";
import { test } from "node:test";
import { layerProblems, selectOrdinaryRun } from "./stack-preflight.ts";

const layer = {
  number: 17,
  state: "open",
  draft: false,
  ancestor: true,
  mergeable: true,
  event: "pull_request",
  status: "completed",
  gate: "success",
};

test("manual success cannot establish PR readiness", () => {
  assert.match(
    layerProblems({ ...layer, event: "workflow_dispatch" }).join(" "),
    /normal PR/,
  );
});

test("passing CI does not hide a non-linear stack or pending mergeability", () => {
  assert.match(
    layerProblems({ ...layer, ancestor: false }).join(" "),
    /ancestor/,
  );
  assert.match(
    layerProblems({ ...layer, mergeable: null }).join(" "),
    /mergeability/,
  );
});

test("every layer needs completed required CI on its current head", () => {
  assert.deepEqual(layerProblems(layer), []);
  assert.ok(layerProblems({ ...layer, gate: "failure" }).length);
  assert.ok(
    layerProblems({ ...layer, status: "in_progress", gate: "" }).length,
  );
  assert.deepEqual(layerProblems({ ...layer, status: "in_progress" }), []);
});

// A later informational label run must not replace ordinary CI evidence.
test("stack readiness ignores journey runs but never skips a pending ordinary run", () => {
  const green = { id: 1, jobs: ["CI passed"] };
  const journey = { id: 2, jobs: ["Journey run (not the merge gate)"] };
  const pending = { id: 3, jobs: [] };
  assert.equal(selectOrdinaryRun([journey, green], (run) => run.jobs)?.id, 1);
  assert.equal(selectOrdinaryRun([pending, green], (run) => run.jobs)?.id, 3);
});
