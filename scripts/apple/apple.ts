// `pnpm apple <command>` — one entry point for the three Apple products under
// apps/apple: the `cubby` CLI harness (SwiftPM executable), the macOS app, and
// the iOS app on a paired iPhone or a simulator. Each command runs the
// prerequisite generators (the cubby-ffi xcframework is Nx-cached by Rust
// content, so a fresh worktree restores it; xcodegen skips when its spec cache
// matches) so a fresh clone works with a single command. Every step prints its
// wall-clock time so a regression in one of them is visible.
//
//   pnpm apple cli <args…>   build the CLI incrementally and run it
//   pnpm apple mac           build, sign, install and relaunch /Applications/Cubby Dev.app
//   pnpm apple ios           build Cubby-iOS, install + launch on the iPhone
//   pnpm apple sim           build Cubby-iOS, install + launch on a simulator
//   pnpm apple gen           build-rust.sh → pnpm generate → xcodegen
//   pnpm apple test          swift test for CubbyKit
//   pnpm apple check [host|app|lint]  cached native checks (all by default)
//
// Options: --device <name> (ios; default: the first paired iPhone),
// --sim <name> (sim; default: the booted simulator, else the first iPhone),
// --verbose (full xcodebuild log instead of -quiet),
// --timing (mac/ios/sim; include the Xcode build timing summary).
//
// Not a debugging tool: when breakpoints are needed, open the Xcode project and
// use the regular `Cubby-*` schemes with ~/.lldbinit-Xcode (apps/apple/AGENTS.md
// "Debugging on device"). This covers the "just put it on the phone" case the
// `-NoDebugger` schemes exist for.
import { APPLE_CLIENT_COMPATIBILITY_VERSION } from "../../packages/shared/src/apple-client-version.ts";
import { APPLE_APP_IDENTITIES } from "../../packages/shared/src/apple-app-identity.ts";
import { installedApprovalVerifier } from "./lib/mac-app-approval.ts";
import { installMacApp, stopMacAppProcesses } from "./lib/mac-app-install.ts";
import { spawnSync } from "node:child_process";
import { checkApple } from "./apple-validation.ts";

import { captureSyncChecked, runSyncChecked } from "../lib/run.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localSimulatorServer } from "./lib/simulator-server.ts";
import { selectIOSSimulator } from "./apple-simulator-selection.ts";
import type { SimulatorInventory } from "../../apps/web/tooling/simulator-inventory-schema.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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
const BUNDLE_ID = APPLE_APP_IDENTITIES.production.bundleIdentifier;
const PRODUCT = `${APPLE_APP_IDENTITIES.production.productName}.app`;
const MAC_IDENTITY = APPLE_APP_IDENTITIES.development;

const usage = `usage: pnpm apple <cli|mac|ios|sim|gen|test|check> [--device <name>] [--sim <name>] [--server <local origin>] [--verbose] [--timing] [-- <cli args>]`;

type Options = {
  command: string;
  device?: string;
  sim?: string;
  server?: string;
  verbose: boolean;
  timing: boolean;
  rest: string[];
};

const parseArguments = (argv: readonly string[]): Options => {
  const [command, ...tail] = argv;
  if (!command) throw new Error(usage);
  const options: Options = { command, verbose: false, timing: false, rest: [] };
  // Everything after `cli` belongs to the CLI, flags included; the other
  // commands take only the options above.
  if (command === "cli" || command === "check") {
    options.rest = [...tail];
    return options;
  }
  for (let index = 0; index < tail.length; index += 1) {
    const argument = tail[index];
    switch (argument) {
      case "--server": {
        if (command !== "sim")
          throw new Error(`--server requires sim\n${usage}`);
        const value = tail[index + 1];
        if (!value || options.server)
          throw new Error(`--server requires one local origin\n${usage}`);
        options.server = localSimulatorServer(value);
        index += 1;
        break;
      }
      case "--device":
      case "--sim": {
        const value = tail[index + 1];
        if (!value) throw new Error(`${argument} requires a value\n${usage}`);
        if (argument === "--device") options.device = value;
        else options.sim = value;
        index += 1;
        break;
      }
      case "--timing":
        if (!["mac", "ios", "sim"].includes(command)) {
          throw new Error(`--timing requires mac, ios, or sim\n${usage}`);
        }
        options.timing = true;
        break;
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
) => runSyncChecked(program, arguments_, cwd);

const capture = (program: string, arguments_: readonly string[]): string =>
  captureSyncChecked(program, arguments_, ROOT);

// Always the full three-slice xcframework: it is one Nx cache entry shared by
// every command and every worktree, where a one-slice build would be a
// separate entry that the next mac/sim/ios launch cannot reuse. Run
// build-rust.sh directly for one-slice iteration.
const ensureFfi = () =>
  run("node", [join(ROOT, "scripts/ensure.ts"), "apple-ffi"]);

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
    // CubbyAPI is generated by swift-openapi-generator's build plugin.
    "-skipPackagePluginValidation",
    ...(options.verbose || options.timing ? [] : ["-quiet"]),
    ...(options.timing ? ["-showBuildTimingSummary"] : []),
    // The index store only feeds Xcode's IDE navigation; a command-line build
    // has no reader for it. Left out of project.yml so GUI builds still index.
    "COMPILER_INDEX_STORE_ENABLE=NO",
    "build",
  ]);

const openSimulatorInterface = () => run("open", ["-a", "Device Hub"]);

const productPath = (platformDirectory: string, product = PRODUCT) =>
  join(DERIVED, "Build/Products", platformDirectory, product);

// ---------------------------------------------------------------------------

const cli = (options: Options) => {
  run("node", [join(ROOT, "scripts/ensure.ts"), "generate"]);
  ensureFfi();
  run("swift", [
    "build",
    "--package-path",
    KIT,
    "--product",
    "cubby",
    FROZEN,
    "--disable-index-store",
  ]);
  const binary = join(KIT, ".build/debug/cubby");
  const result = spawnSync(binary, options.rest, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
};

// macOS privacy grants (Photos, browser automation, notifications) record the
// approving app's designated requirement. A team-signed Debug build keeps one
// requirement across rebuilds and worktrees; an ad-hoc build (for example from
// a CODE_SIGNING_ALLOWED=NO command into this DerivedData) has a per-build
// cdhash requirement, so launching it replaces every grant and the next signed
// build prompts again.
const assertTeamSigned = (app: string) => {
  const team = readFileSync(join(APPLE, "project.yml"), "utf8").match(
    /^\s*DEVELOPMENT_TEAM:\s*([A-Z\d]{10})\s*$/mu,
  )?.[1];
  if (!team) throw new Error("apps/apple/project.yml has no DEVELOPMENT_TEAM");
  const signer = `certificate leaf[subject.OU] = "${team}"`;
  const verified = spawnSync(
    "codesign",
    [
      "--verify",
      "--strict",
      `-R=anchor apple generic and identifier "${MAC_IDENTITY.bundleIdentifier}" and ${signer}`,
      app,
    ],
    { encoding: "utf8" },
  );
  if (verified.status !== 0)
    throw new Error(
      `${app} is not signed by team ${team}; launching it would reset macOS privacy approvals. ` +
        `Remove apps/apple/DerivedData/Build/Products/Debug/${MAC_IDENTITY.productName}.app and rerun.\n${verified.stderr.trim()}`,
    );
};

const mac = async (options: Options) => {
  ensureFfi();
  run("node", [join(ROOT, "scripts/ensure.ts"), "generate"]);
  ensureProject();
  xcodebuild("Cubby-macOS", "platform=macOS,arch=arm64", options);
  const app = productPath("Debug", `${MAC_IDENTITY.productName}.app`);
  const version = capture("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    join(app, "Contents/Info.plist"),
  ]).trim();
  if (version !== APPLE_CLIENT_COMPATIBILITY_VERSION)
    throw new Error(
      `Built app version ${version} differs from compatibility version ${APPLE_CLIENT_COMPATIBILITY_VERSION}`,
    );
  const installed = join("/Applications", `${MAC_IDENTITY.productName}.app`);
  const verifyApproval = existsSync(installed)
    ? installedApprovalVerifier(installed)
    : undefined;
  const retainedBackup = await installMacApp(
    app,
    installed,
    (candidate) => {
      assertTeamSigned(candidate);
      verifyApproval?.(candidate);
    },
    async () => {
      const executable = join(
        installed,
        "Contents/MacOS",
        MAC_IDENTITY.productName,
      );
      const pids = capture("ps", ["-axo", "pid=,comm="])
        .split("\n")
        .flatMap((line) => {
          const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
          return match?.[2] === executable ? [Number(match[1])] : [];
        });
      await stopMacAppProcesses(pids);
    },
  );
  // Launch the verified installed copy explicitly, after the old process exits.
  run("open", ["-n", installed]);
  if (retainedBackup)
    process.stdout.write(
      `Installed and relaunched Cubby; previous app retained because cleanup failed: ${retainedBackup}\n`,
    );
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
  run("node", [join(ROOT, "scripts/ensure.ts"), "generate"]);
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

const pickSimulator = (name: string | undefined) => {
  // SAFETY: simctl's JSON schema is Apple's; selectIOSSimulator reads only the
  // declared fields. This script stays dependency-free, so no Zod parse here.
  const inventory = JSON.parse(
    capture("xcrun", ["simctl", "list", "devices", "available", "-j"]),
  ) as SimulatorInventory;
  const simulator = selectIOSSimulator(inventory, name);
  if (!simulator)
    throw new Error(
      `no iPhone 17 simulator${name ? ` named '${name}'` : ""}; create one with \`xcrun simctl create\``,
    );
  return simulator;
};

const sim = (options: Options) => {
  const simulator = pickSimulator(options.sim);
  // Boot returns as soon as the device starts coming up, so kicking it off
  // first overlaps the boot with the build; bootstatus below waits for it.
  if (simulator.state !== "Booted") {
    run("xcrun", ["simctl", "boot", simulator.udid]);
  }
  run("node", [join(ROOT, "scripts/ensure.ts"), "generate"]);
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
    ...(options.server ? ["--cubby-dev-server", options.server] : []),
  ]);
};

const gen = () => {
  ensureFfi();
  run("node", [join(ROOT, "scripts/ensure.ts"), "generate"]);
  ensureProject();
};

const test = () => {
  run("node", [join(ROOT, "scripts/ensure.ts"), "generate"]);
  ensureFfi();
  run("swift", [
    "test",
    "--package-path",
    KIT,
    FROZEN,
    "--disable-index-store",
  ]);
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
      if (options.rest.length > 1)
        throw new Error("usage: pnpm apple check [host|app|lint]");
      return checkApple(ROOT, options.rest[0]);
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
  await main();
} catch (error) {
  process.stderr.write(
    `apple: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
