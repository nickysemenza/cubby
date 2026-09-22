import assert from "node:assert/strict";
import test from "node:test";

import { serviceMode } from "./test-services.ts";

// Table-driven: CUBBY_TEST_SERVICES parsing is the one regression that would
// silently misroute every `test:*` invocation (falling back to `apple` when
// a typo'd value should have failed loudly, or vice versa).
const cases: [
  name: string,
  env: NodeJS.ProcessEnv,
  warmFlag: boolean,
  expected: "apple" | "external" | "warm" | Error,
][] = [
  ["unset defaults to apple", {}, false, "apple"],
  ["external", { CUBBY_TEST_SERVICES: "external" }, false, "external"],
  ["apple", { CUBBY_TEST_SERVICES: "apple" }, false, "apple"],
  ["warm via env", { CUBBY_TEST_SERVICES: "warm" }, false, "warm"],
  ["warm via --warm flag overrides unset env", {}, true, "warm"],
  [
    "invalid value rejected even with --warm",
    { CUBBY_TEST_SERVICES: "bogus" },
    true,
    new Error(),
  ],
  [
    "invalid value rejected",
    { CUBBY_TEST_SERVICES: "bogus" },
    false,
    new Error(),
  ],
];

for (const [name, env, warmFlag, expected] of cases) {
  test(`serviceMode: ${name}`, () => {
    if (expected instanceof Error) {
      assert.throws(() => serviceMode(env, warmFlag));
    } else {
      assert.equal(serviceMode(env, warmFlag), expected);
    }
  });
}
