// `pnpm apple <command>` — one entry point for the three Apple products under
// apps/apple: the `cubby` CLI harness (SwiftPM executable), the macOS app, and
// the iOS app on a paired iPhone or a simulator. Each command runs the
// prerequisite generators (the cubby-ffi xcframework is Nx-cached by Rust
// content, so a fresh worktree restores it; xcodegen skips when its spec cache
// matches) so a fresh clone works with a single command. Every step prints its
// wall-clock time so a regression in one of them is visible.
//
//   pnpm apple cli <args…>   build the CLI incrementally and run it
//   pnpm apple mac           build Cubby-macOS and open the .app (no LLDB)
//   pnpm apple ios           build Cubby-iOS, install + launch on the iPhone
//   pnpm apple sim           build Cubby-iOS, install + launch on a simulator
//   pnpm apple gen           build-rust.sh → generate-openapi.sh → xcodegen
//   pnpm apple test          swift test for CubbyKit
//   pnpm apple check         native formatting, tests, API drift, and simulator build
//
// Options: --device <name> (ios; default: the first paired iPhone),
// --sim <name> (sim; default: the booted simulator, else the first iPhone),
// --verbose (full xcodebuild log instead of -quiet).
//
// Not a debugging tool: when breakpoints are needed, open the Xcode project and
// use the regular `Cubby-*` schemes with ~/.lldbinit-Xcode (apps/apple/AGENTS.md
// "Debugging on device"). This covers the "just put it on the phone" case the
// `-NoDebugger` schemes exist for.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLE = join(ROOT, "apps/apple");
const KIT = join(APPLE, "CubbyKit");
// Frozen-lockfile semantics for the swift CLI: without this every build and
// test re-resolves and rewrites CubbyKit/Package.resolved (only the originHash,
// which differs per tool and checkout path). Pins change only via a deliberate
// `swift package update` in CubbyKit.
const FROZEN = "--force-resolved-versions";
const PROJECT = join(APPLE, "Cubby.xcodeproj");
// Pinned so product paths are deterministic; `DerivedData/` is already in
// apps/apple/.gitignore.
const DERIVED = join(APPLE, "DerivedData");
const BUNDLE_ID = "com.nickysemenza.cubby";
const PRODUCT = "Cubby.app";

const usage = `usage: pnpm apple <cli|mac|ios|sim|gen|test|check> [--device <name>] [--sim <name>] [--verbose] [-- <cli args>]`;

type Options = {
  command: string;
  device?: string;
  sim?: string;
  verbose: boolean;
  rest: string[];
};

const parseArguments = (argv: readonly string[]): Options => {
  const [command, ...tail] = argv;
  if (!command) throw new Error(usage);
  const options: Options = { command, verbose: false, rest: [] };
  // Everything after `cli` belongs to the CLI, flags included; the other
  // commands take only the options above.
  if (command === "cli") {
    options.rest = [...tail];
    return options;
  }
  for (let index = 0; index < tail.length; index += 1) {
    const argument = tail[index];
    switch (argument) {
      case "--device":
      case "--sim": {
        const value = tail[index + 1];
        if (!value) throw new Error(`${argument} requires a value\n${usage}`);
        if (argument === "--device") options.device = value;
        else options.sim = value;
        index += 1;
        break;
      }
      case "--verbose":
        options.verbose = true;
        break;
      default:
        throw new Error(`unknown argument '${argument}'\n${usage}`);
    }
  }
  return options;
};

const run = (
  program: string,
  arguments_: readonly string[],
  cwd: string = ROOT,
) => {
  process.stdout.write(`$ ${program} ${arguments_.join(" ")}\n`);
  const started = performance.now();
  const result = spawnSync(program, arguments_, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} exited with status ${result.status}`);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  process.stdout.write(`==> ${program} (${seconds}s)\n`);
};

const capture = (program: string, arguments_: readonly string[]): string => {
  const result = spawnSync(program, arguments_, {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${program} ${arguments_.join(" ")} exited with status ${result.status}\n${result.stderr}`,
    );
  }
  return result.stdout;
};

// Always the full three-slice xcframework: it is one Nx cache entry shared by
// every command and every worktree, where a one-slice build would be a
// separate entry that the next mac/sim/ios launch cannot reuse. Run
// build-rust.sh directly for one-slice iteration.
const ensureFfi = () =>
  run("node", [join(ROOT, "scripts/ensure-apple-ffi.ts")]);

// `--use-cache` regenerates only when the spec or its tracked file set
// changed (or the gitignored project is missing), so a project.yml edit takes
// effect without deleting Cubby.xcodeproj by hand.
const ensureProject = () =>
  run("xcodegen", [
    "generate",
    "--spec",
    join(APPLE, "project.yml"),
    "--use-cache",
  ]);

const xcodebuild = (
  scheme: "Cubby-iOS" | "Cubby-macOS",
  destination: string,
  options: Options,
) =>
  run("xcodebuild", [
    "-project",
    PROJECT,
    "-scheme",
    scheme,
    "-configuration",
    "Debug",
    "-destination",
    destination,
    "-derivedDataPath",
    DERIVED,
    // Automatic signing (project.yml) may need to mint a profile for a new
    // device or a rotated team certificate. -allowProvisioningUpdates alone
    // refreshes profiles but never registers a device, so a machine that has
    // never been added to the team (a fresh Mac, an unseen iPhone) fails with
    // "isn't registered" → "No profiles found"; the second flag adds it.
    "-allowProvisioningUpdates",
    "-allowProvisioningDeviceRegistration",
    ...(options.verbose ? [] : ["-quiet"]),
    // The index store only feeds Xcode's IDE navigation; a command-line build
    // has no reader for it. Left out of project.yml so GUI builds still index.
    "COMPILER_INDEX_STORE_ENABLE=NO",
    "build",
  ]);

/// Xcode 27 replaced Simulator.app with Device Hub. Prefer its device canvas,
/// but keep the Xcode 26 app as a fallback so the same command remains usable
/// on older developer machines.
const openSimulatorInterface = () => {
  const started = performance.now();
  const result = spawnSync("open", ["-a", "Device Hub"], { stdio: "inherit" });
  if (!result.error && result.status === 0) {
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    process.stdout.write(`==> Device Hub (${seconds}s)\n`);
    return;
  }
  run("open", ["-a", "Simulator"]);
};

const productPath = (platformDirectory: string) =>
  join(DERIVED, "Build/Products", platformDirectory, PRODUCT);

// ---------------------------------------------------------------------------

const cli = (options: Options) => {
  ensureFfi();
  run("swift", ["build", "--package-path", KIT, "--product", "cubby", FROZEN]);
  const binary = join(KIT, ".build/debug/cubby");
  const result = spawnSync(binary, options.rest, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
};

const mac = (options: Options) => {
  ensureFfi();
  ensureProject();
  xcodebuild("Cubby-macOS", "platform=macOS,arch=arm64", options);
  const app = productPath("Debug");
  // `open` on a running app only activates it, so the old binary would keep
  // running; pkill exits 1 when nothing matched, which is fine.
  spawnSync("pkill", ["-x", "Cubby"], { stdio: "ignore" });
  run("open", [app]);
};

// `devicectl` only writes JSON to a file, never stdout.
const devicectlJson = <T>(arguments_: readonly string[]): T => {
  const directory = mkdtempSync(join(tmpdir(), "cubby-devicectl-"));
  const output = join(directory, "out.json");
  try {
    capture("xcrun", ["devicectl", ...arguments_, "--json-output", output]);
    // SAFETY: devicectl's JSON schema is Apple's, not ours; callers read only
    // the fields they declare and a missing one surfaces as a TypeError.
    return JSON.parse(readFileSync(output, "utf8")) as T;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

type DeviceList = {
  result: {
    devices: {
      identifier: string;
      deviceProperties: { name: string };
      connectionProperties: { pairingState: string };
      hardwareProperties: { platform: string };
    }[];
  };
};

const pickDevice = (name: string | undefined) => {
  const devices = devicectlJson<DeviceList>(["list", "devices"])
    .result.devices.filter(
      (device) =>
        device.hardwareProperties.platform === "iOS" &&
        device.connectionProperties.pairingState === "paired",
    )
    .map((device) => ({
      id: device.identifier,
      name: device.deviceProperties.name,
    }));
  const device = name
    ? devices.find((candidate) => candidate.name === name)
    : devices[0];
  if (!device) {
    const known = devices.map((candidate) => `'${candidate.name}'`).join(", ");
    throw new Error(
      name
        ? `no paired iPhone named '${name}' (paired: ${known || "none"})`
        : "no paired iPhone; pair one in Xcode (Window → Devices and Simulators) first",
    );
  }
  return device;
};

const ios = (options: Options) => {
  const device = pickDevice(options.device);
  ensureFfi();
  ensureProject();
  xcodebuild("Cubby-iOS", `platform=iOS,id=${device.id}`, options);
  const app = productPath("Debug-iphoneos");
  // The phone has to be unlocked for both steps.
  run("xcrun", [
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    device.id,
    app,
  ]);
  run("xcrun", [
    "devicectl",
    "device",
    "process",
    "launch",
    "--terminate-existing",
    "--device",
    device.id,
    BUNDLE_ID,
  ]);
};

type SimulatorList = {
  devices: Record<
    string,
    { udid: string; name: string; state: string; isAvailable: boolean }[]
  >;
};

const pickSimulator = (name: string | undefined) => {
  // SAFETY: simctl's JSON schema is Apple's; only the declared fields are read
  // and a missing one surfaces as a TypeError.
  const list = JSON.parse(
    capture("xcrun", ["simctl", "list", "devices", "available", "-j"]),
  ) as SimulatorList;
  const simulators = Object.entries(list.devices)
    .filter(([runtime]) => runtime.includes(".iOS-"))
    .flatMap(([, devices]) => devices);
  const simulator = name
    ? simulators.find((candidate) => candidate.name === name)
    : (simulators.find((candidate) => candidate.state === "Booted") ??
      simulators.find((candidate) => candidate.name.includes("iPhone")));
  if (!simulator) {
    const known = simulators
      .map((candidate) => `'${candidate.name}'`)
      .join(", ");
    throw new Error(
      `no iOS simulator${name ? ` named '${name}'` : ""} (available: ${known || "none"})`,
    );
  }
  return simulator;
};

const sim = (options: Options) => {
  const simulator = pickSimulator(options.sim);
  // Boot returns as soon as the device starts coming up, so kicking it off
  // first overlaps the boot with the build; bootstatus below waits for it.
  if (simulator.state !== "Booted") {
    run("xcrun", ["simctl", "boot", simulator.udid]);
  }
  ensureFfi();
  ensureProject();
  xcodebuild(
    "Cubby-iOS",
    `platform=iOS Simulator,id=${simulator.udid}`,
    options,
  );
  run("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
  openSimulatorInterface();
  run("xcrun", [
    "simctl",
    "install",
    simulator.udid,
    productPath("Debug-iphonesimulator"),
  ]);
  run("xcrun", [
    "simctl",
    "launch",
    "--terminate-running-process",
    simulator.udid,
    BUNDLE_ID,
  ]);
};

const gen = () => {
  ensureFfi();
  run(join(APPLE, "scripts/generate-openapi.sh"), []);
  ensureProject();
};

const test = () => {
  ensureFfi();
  run("swift", ["test", "--package-path", KIT, FROZEN]);
};

// ---------------------------------------------------------------------------

const main = () => {
  const options = parseArguments(process.argv.slice(2));
  switch (options.command) {
    case "cli":
      return cli(options);
    case "mac":
      return mac(options);
    case "ios":
      return ios(options);
    case "sim":
      return sim(options);
    case "gen":
      return gen();
    case "test":
      return test();
    case "check":
      return run("sh", [join(ROOT, "scripts/apple-check.sh")]);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`${usage}\n`);
      return;
    default:
      throw new Error(`unknown command '${options.command}'\n${usage}`);
  }
};

try {
  main();
} catch (error) {
  process.stderr.write(
    `apple: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
