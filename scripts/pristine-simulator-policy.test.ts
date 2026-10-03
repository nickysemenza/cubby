// A seeded XCTest cache must reject app data and must not launch its runner
// with credentials inherited from an AI job. Prefix lookalikes are not SDK apps.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assertPristineSimulatorApps,
  pristineRunnerEnvironment,
} from "./pristine-simulator-policy.ts";

test("permits the installed public runner only after preparation", () => {
  const stock = ["com.apple.Preferences", "com.apple.mobilesafari"];
  const prepared = [
    ...stock,
    "com.callstack.agentdevice.runner.uitests.xctrunner",
  ];
  assert.doesNotThrow(() => assertPristineSimulatorApps(stock, false));
  assert.throws(() => assertPristineSimulatorApps(prepared, false));
  assert.doesNotThrow(() => assertPristineSimulatorApps(prepared, true));
});

test("refuses Cubby and bundle identifiers resembling the public runner", () => {
  for (const id of [
    "com.nickysemenza.cubby",
    "com.callstack.agentdevice.runner.private",
    "com.callstack.agentdevice.runner.uitests.xctrunner.private",
  ]) {
    assert.throws(() =>
      assertPristineSimulatorApps(["com.apple.Preferences", id], true),
    );
  }
});

test("passes tool locations but no inherited credentials or runner overrides", () => {
  const env = pristineRunnerEnvironment({
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    TMPDIR: "/synthetic/tmp",
    DEVELOPER_DIR: "/synthetic/Xcode",
    TESTER_ARMY_CF_API_TOKEN: "synthetic-secret",
    OPENAI_API_KEY: "synthetic-secret",
    AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID: "private.app",
    ARBITRARY_CREDENTIAL: "synthetic-secret",
  });
  assert.equal(env.PATH, "/synthetic/bin");
  assert.equal(env.HOME, "/synthetic/home");
  assert.equal(env.TMPDIR, "/synthetic/tmp");
  assert.equal(env.DEVELOPER_DIR, "/synthetic/Xcode");
  assert.equal(
    env.AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID,
    "com.callstack.agentdevice.runner",
  );
  assert.equal(
    env.AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID,
    "com.callstack.agentdevice.runner.uitests",
  );
  assert.equal(env.E2E_TELEMETRY_DISABLED, "1");
  assert.equal(env.TESTER_ARMY_CF_API_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ARBITRARY_CREDENTIAL, undefined);
});
