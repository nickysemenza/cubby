import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, totalmem } from "node:os";
import path from "node:path";

import { selectIOSSimulator } from "./apple-simulator-selection.ts";

// Compare hosted hardware at the Simulator/XCTest boundary without app builds,
// inference, private app data, or raw accessibility trees in saved evidence.
const output = path.resolve("artifacts/apple-runner-benchmark");
mkdirSync(output, { recursive: true });
const started = performance.now();
const phases: Array<{ name: string; durationMs: number; passed: boolean }> = [];
let passed = false;
let failedPhase: string | undefined;
function measure(name: string, command: string, args: string[]): string {
  const start = performance.now();
  let ok = false;
  try {
    const result = execFileSync(command, args, {
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    ok = true;
    return result;
  } catch {
    failedPhase = name;
    throw new Error(`Apple runner benchmark failed in ${name}`);
  } finally {
    const durationMs = Math.round(performance.now() - start);
    phases.push({ name, durationMs, passed: ok });
    console.log(`${name}: ${durationMs}ms (${ok ? "passed" : "failed"})`);
  }
}

const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const toolchain = execFileSync("xcodebuild", ["-version"], {
  encoding: "utf8",
}).trim();
try {
  const inventory = JSON.parse(
    measure("inventory", "xcrun", [
      "simctl",
      "list",
      "devices",
      "available",
      "-j",
    ]),
  );
  const device = selectIOSSimulator(inventory);
  if (!device) throw new Error("No supported iPhone simulator available");
  if (device.state !== "Booted")
    measure("simulator-boot-request", "xcrun", ["simctl", "boot", device.udid]);
  measure("simulator-ready", "xcrun", [
    "simctl",
    "bootstatus",
    device.udid,
    "-b",
  ]);
  const common = ["--platform", "ios", "--udid", device.udid];
  for (const mode of ["cold", "warm"]) {
    measure(`${mode}-runner-prepare`, "pnpm", [
      "exec",
      "agent-device",
      "prepare",
      "ios-runner",
      ...common,
      "--timeout",
      "240000",
    ]);
    measure(`${mode}-settings-open`, "pnpm", [
      "exec",
      "agent-device",
      "open",
      "com.apple.Preferences",
      ...common,
    ]);
    const snapshot = measure(`${mode}-snapshot`, "pnpm", [
      "exec",
      "agent-device",
      "snapshot",
      ...common,
    ]);
    if (!snapshot.trim()) throw new Error("Settings snapshot was empty");
  }
  passed = true;
} finally {
  const documents = {
    "run-manifest.json": {
      schemaVersion: 1,
      revision,
      toolchain,
      hardware: {
        architecture: arch(),
        cpuCount: cpus().length,
        memoryBytes: totalmem(),
      },
      replay: "node scripts/benchmark-apple-runner.ts",
      scope:
        "Settings Simulator/XCTest startup probe; does not certify Cubby E2E",
    },
    "run-results.json": {
      schemaVersion: 1,
      status: passed ? "passed" : "failed",
      failedPhase,
      durationMs: Math.round(performance.now() - started),
      phases,
    },
  };
  for (const [name, data] of Object.entries(documents))
    writeFileSync(
      path.join(output, name),
      `${JSON.stringify(data, null, 2)}\n`,
    );
  writeFileSync(
    path.join(output, "SHA256SUMS"),
    Object.keys(documents)
      .map(
        (name) =>
          `${createHash("sha256")
            .update(readFileSync(path.join(output, name)))
            .digest("hex")}  ${name}\n`,
      )
      .join(""),
  );
}
