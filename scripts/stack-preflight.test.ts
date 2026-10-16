import assert from "node:assert/strict";
import { test } from "node:test";
import { layerProblems } from "./stack-preflight.ts";

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
  assert.ok(layerProblems({ ...layer, status: "in_progress" }).length);
});
