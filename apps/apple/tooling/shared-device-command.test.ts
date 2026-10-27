import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { sharedDeviceCommand } from "./lib/shared-device-command.ts";

// Wrong session/host flags drive another run; stopping the shared daemon or
// closing its session would break the user's live Device panel.
test("simulator commands keep the supplied shared launcher and session", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-shared-device-"));
  try {
    const log = path.join(root, "args.json");
    const command = path.join(root, "agent-device");
    writeFileSync(
      command,
      `#!${process.execPath}\nimport fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));`,
      { mode: 0o755 },
    );
    const targetArgs = [
      "--platform",
      "ios",
      "--udid",
      "synthetic-device",
      "--config",
      "/synthetic/config.json",
      "--session",
      "synthetic-panel",
    ];
    const module = path.join(
      import.meta.dirname,
      "lib/shared-device-command.ts",
    );
    const script = `import assert from 'node:assert/strict'; import { sharedDeviceCommand } from ${JSON.stringify(module)}; import { spawnSync } from 'node:child_process'; const env={CUBBY_E2E_AGENT_DEVICE:${JSON.stringify(JSON.stringify({ command, targetArgs }))}}; const routed=sharedDeviceCommand('pnpm',['exec','agent-device','snapshot','-i','--platform','ios','--udid','synthetic-device','--session','temporary-run'],env); assert.equal(spawnSync(routed.command,routed.args).status,0); assert.equal(sharedDeviceCommand('pnpm',['exec','agent-device','close'],env),undefined); assert.equal(sharedDeviceCommand('pnpm',['exec','agent-device','daemon','stop'],env),undefined); assert.throws(()=>sharedDeviceCommand('pnpm',['exec','agent-device','snapshot','--udid','other-device'],env),/device/);`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
      "snapshot",
      "-i",
      ...targetArgs,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

// A shared target mismatch must fail before simulator boot/install side effects.
test("simulator rejects a conflicting shared target before setup", () => {
  const result = spawnSync(
    "pnpm",
    ["--dir", "apps/web", "exec", "tsx", "tooling/sim-e2e.ts"],
    {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        CUBBY_SIM_DEVICE: "other-device",
        CUBBY_E2E_AGENT_DEVICE: JSON.stringify({
          command: "/synthetic/driver",
          targetArgs: [
            "--platform",
            "ios",
            "--udid",
            "synthetic-device",
            "--config",
            "/synthetic/config",
            "--session",
            "panel",
          ],
        }),
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Shared driver targets a different device/);
});

// `test` forks an attempt session, which cannot borrow an already-open panel.
test("shared single-file journeys replay inside the existing session", () => {
  const module = path.join(import.meta.dirname, "lib/shared-device-command.ts");
  const driver = {
    command: "/synthetic/driver",
    targetArgs: [
      "--platform",
      "ios",
      "--udid",
      "synthetic-device",
      "--config",
      "/synthetic/config",
      "--session",
      "panel",
    ],
  };
  const script = `import assert from 'node:assert/strict'; import { sharedDeviceCommand } from ${JSON.stringify(module)}; const result = sharedDeviceCommand('pnpm', ['exec','agent-device','test','journey.ad','--reporter','default','--artifacts-dir','/synthetic/artifacts','-e','PRODUCT_ID=synthetic'], {CUBBY_E2E_AGENT_DEVICE:${JSON.stringify(JSON.stringify(driver))}}); assert.deepEqual(result.args, ['replay','journey.ad','--timeout','240000','-e','PRODUCT_ID=synthetic',...${JSON.stringify(driver.targetArgs)}]);`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

// Installation and launch must not bypass the Device panel's host/session binding.
test("shared lifecycle commands use the supplied device launcher", () => {
  const targetArgs = [
    "--platform",
    "ios",
    "--udid",
    "synthetic-device",
    "--config",
    "/synthetic/config",
    "--session",
    "panel",
  ];
  const driver = { command: "/synthetic/driver", targetArgs };
  const env = { CUBBY_E2E_AGENT_DEVICE: JSON.stringify(driver) };
  assert.deepEqual(
    sharedDeviceCommand(
      "xcrun",
      ["simctl", "install", "synthetic-device", "/synthetic/Cubby.app"],
      env,
    ),
    {
      command: driver.command,
      args: [
        "install",
        "com.nickysemenza.cubby",
        "/synthetic/Cubby.app",
        ...targetArgs,
      ],
    },
  );
  assert.deepEqual(
    sharedDeviceCommand(
      "xcrun",
      [
        "simctl",
        "launch",
        "--terminate-running-process",
        "synthetic-device",
        "com.nickysemenza.cubby",
        "--cubby-e2e-server",
        "http://127.0.0.1:4000",
      ],
      env,
    ),
    {
      command: driver.command,
      args: [
        "open",
        "com.nickysemenza.cubby",
        "--relaunch",
        "--launch-args",
        "--cubby-e2e-server",
        "--launch-args",
        "http://127.0.0.1:4000",
        ...targetArgs,
      ],
    },
  );
  assert.equal(
    sharedDeviceCommand(
      "xcrun",
      ["simctl", "bootstatus", "synthetic-device", "-b"],
      env,
    ),
    undefined,
  );
  assert.throws(
    () =>
      sharedDeviceCommand(
        "xcrun",
        ["simctl", "install", "other-device", "/synthetic/Cubby.app"],
        env,
      ),
    /different device/,
  );
});
