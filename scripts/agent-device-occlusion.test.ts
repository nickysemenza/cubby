import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The published driver's internal occlusion pass is patched because SwiftUI
// reports an empty floating-bar wrapper across almost the entire window.
test("floating-bar wrappers preserve actions while real toolbars cover them", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';
const { t: markOccluded } = await import(new URL('./snapshot-occlusion.js', import.meta.resolve('agent-device')));
const nodes = [
  { index: 0, type: 'Window', rect: { x: 0, y: 0, width: 400, height: 800 } },
  { index: 1, parentIndex: 0, type: 'Button', label: 'Synthetic action', hittable: true, rect: { x: 100, y: 400, width: 100, height: 40 } },
  { index: 2, parentIndex: 0, type: 'Other', rect: { x: 0, y: 0, width: 400, height: 800 } },
  { index: 3, parentIndex: 2, type: 'Toolbar', role: '_UIFloatingBarContainerView', rect: { x: 0, y: 0, width: 400, height: 750 } },
];
assert.equal(markOccluded(nodes)[1].interactionBlocked, undefined);
nodes[3] = { ...nodes[3], role: 'Toolbar', rect: { x: 80, y: 390, width: 160, height: 60 } };
assert.equal(markOccluded(nodes)[1].interactionBlocked, 'covered');`,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
