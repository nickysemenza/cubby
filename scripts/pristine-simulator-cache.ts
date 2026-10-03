import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { arch, homedir } from "node:os";
import path from "node:path";
import { selectIOSSimulator } from "./apple-simulator-selection.ts";

// Cache only a stock hosted device, before any test app, runner, or credentials
// reach it. Never save its data again after the full journey mutates the device.
if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "darwin")
  throw new Error(
    "Pristine simulator caching requires a disposable hosted Mac",
  );
const capture = (args: string[]) =>
  execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
const inventory = JSON.parse(capture(["list", "devices", "available", "-j"]));
const device = selectIOSSimulator(inventory);
if (
  !device ||
  !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device.udid)
)
  throw new Error("Stock iPhone simulator is unavailable");
const mode = process.argv[2];
if (mode === "key") {
  const runtimes = JSON.parse(capture(["list", "runtimes", "-j"]));
  const runtime = runtimes.runtimes.find(
    (candidate: { identifier: string }) =>
      candidate.identifier === device.runtime,
  );
  if (!runtime) throw new Error("Stock simulator runtime is unavailable");
  const identity = {
    architecture: arch(),
    image: process.env.ImageVersion,
    os: execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim(),
    xcode: execFileSync("xcodebuild", ["-version"], {
      encoding: "utf8",
    }).trim(),
    runtime: {
      identifier: runtime.identifier,
      version: runtime.version,
      build: runtime.buildversion,
      root: runtime.runtimeRoot,
      bundle: runtime.bundlePath,
    },
    device: device.udid,
    policy: readFileSync(new URL(import.meta.url)),
  };
  const key = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
  if (!process.env.GITHUB_OUTPUT)
    throw new Error("GitHub step output is unavailable");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `device-id=${device.udid}\ndata-path=${path.join(homedir(), "Library/Developer/CoreSimulator/Devices", device.udid, "data")}\ncache-key=pristine-ios-v1-${key}\n`,
  );
} else if (mode === "seed") {
  if (device.udid !== process.argv[3])
    throw new Error("Stock device selection changed");
  if (device.state !== "Booted") capture(["boot", device.udid]);
  try {
    capture(["bootstatus", device.udid, "-b"]);
    const installed = JSON.parse(
      execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
        input: capture(["listapps", device.udid]),
        encoding: "utf8",
      }),
    );
    if (Object.keys(installed).some((id) => !id.startsWith("com.apple.")))
      throw new Error(
        "Refusing to cache a simulator with non-stock applications",
      );
  } finally {
    capture(["shutdown", device.udid]);
  }
  console.log(
    "Initialized and shut down the stock simulator before test installation",
  );
} else
  throw new Error("Usage: pristine-simulator-cache.ts key|seed <device-id>");
