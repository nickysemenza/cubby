// Certifies a compiled simulator app only after dependency resolution. This
// guard is independent of DerivedData's incremental-build heuristics.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestFiles, walkFiles } from "./lib/tree-digest.ts";

// Both hosted callers compile this profile. Its bytes also enter the cache key;
// harness and workflow changes do not change the app's compiler inputs.
export const hostedSimulatorBuildArgs = Object.freeze([
  "-project",
  "apps/apple/Cubby.xcodeproj",
  "-scheme",
  "Cubby-iOS",
  "-configuration",
  "Debug",
  "-destination",
  "generic/platform=iOS Simulator",
  "-derivedDataPath",
  "apps/apple/DerivedData",
  "-clonedSourcePackagesDirPath",
  "apps/apple/SourcePackages",
  "-skipPackagePluginValidation",
  "-skipMacroValidation",
  "SWIFT_ENABLE_BATCH_MODE=YES",
  "-xcconfig",
  "apps/apple/ci-simulator.xcconfig",
  "ONLY_ACTIVE_ARCH=YES",
  "CODE_SIGNING_ALLOWED=NO",
  "COMPILER_INDEX_STORE_ENABLE=NO",
]);

const bundlePath =
  "apps/apple/DerivedData/Build/Products/Debug-iphonesimulator/Cubby.app";
const markerPath = "apps/apple/DerivedData/cubby-simulator-build.json";
const packageWorkspacePath = "apps/apple/SourcePackages/workspace-state.json";
const sourceTrees = [
  "apps/apple/App",
  "apps/apple/CubbyKit/Sources",
  "apps/apple/CubbyKit/Frameworks",
];
const requiredInputs = [
  "apps/apple/CubbyKit/Frameworks/CubbyFFI.xcframework/.fingerprint",
  "apps/apple/CubbyKit/Package.swift",
  "apps/apple/CubbyKit/Package.resolved",
  "apps/apple/project.yml",
  "apps/apple/packages.yml",
  "apps/apple/ci-simulator.xcconfig",
  "apps/apple/Cubby.xcodeproj/project.pbxproj",
  packageWorkspacePath,
];

// Swift rewrites the dependency/artifact sets in different orders while
// resolving and building. Preserve every value, but not serialization order.
function canonicalPackageState(source: string): string {
  // The reviver visits children first. Collect every property so the sorted
  // replacer preserves unknown Swift fields as well as current dependency data.
  const keys = new Set<string>();
  const state = JSON.parse(source, (key, value) => {
    keys.add(key);
    if (
      (key === "dependencies" || key === "artifacts") &&
      Array.isArray(value)
    ) {
      const properties = [...keys].sort();
      value.sort((left, right) =>
        JSON.stringify(left, properties).localeCompare(
          JSON.stringify(right, properties),
        ),
      );
    }
    return value;
  });
  return JSON.stringify(state, [...keys].sort());
}
const buildDrivers = [
  "scripts/apple-check.sh",
  "apps/apple/scripts/prepare-project.sh",
  "scripts/apple-simulator-build-cache.ts",
];

export function simulatorBuildFingerprint(
  root: string,
  toolchain: string,
  buildArgs: readonly string[] = hostedSimulatorBuildArgs,
): string {
  const inputs = requiredInputs.map((file) => path.join(root, file));
  for (const file of inputs) {
    if (!existsSync(file))
      throw new Error(
        `Simulator build input is missing: ${path.relative(root, file)}`,
      );
  }
  for (const tree of sourceTrees) {
    const files = walkFiles(path.join(root, tree), { includeSymlinks: true });
    if (files.length === 0)
      throw new Error(`Simulator build inputs are missing: ${tree}`);
    inputs.push(...files);
  }
  inputs.push(
    ...buildDrivers.flatMap((file) => walkFiles(path.join(root, file))),
  );
  const workspaceFile = path.join(root, packageWorkspacePath);
  const packageState = canonicalPackageState(
    readFileSync(workspaceFile, "utf8"),
  );
  return digestFiles(
    root,
    [...new Set(inputs)].filter((file) => file !== workspaceFile).sort(),
    {
      seed: `simulator-app-v3:${JSON.stringify(buildArgs)}:${toolchain}:${packageState}`,
      links: true,
    },
  );
}

function buildCertificate(
  root: string,
  toolchain: string,
  buildArgs: readonly string[],
) {
  const bundle = path.join(root, bundlePath);
  for (const file of ["Cubby", "Info.plist"]) {
    if (!existsSync(path.join(bundle, file)))
      throw new Error(`Simulator app is incomplete: ${file}`);
  }
  return JSON.stringify({
    schemaVersion: 1,
    inputs: simulatorBuildFingerprint(root, toolchain, buildArgs),
    bundle: digestFiles(bundle, walkFiles(bundle, { includeSymlinks: true }), {
      links: true,
    }),
  });
}

export function stampSimulatorBuild(
  root: string,
  toolchain: string,
  expected: string,
  buildArgs: readonly string[] = hostedSimulatorBuildArgs,
): void {
  if (simulatorBuildFingerprint(root, toolchain, buildArgs) !== expected) {
    throw new Error("Simulator build inputs changed during compilation");
  }
  writeFileSync(
    path.join(root, markerPath),
    buildCertificate(root, toolchain, buildArgs),
  );
}

export function hasMatchingSimulatorBuild(
  root: string,
  toolchain: string,
  buildArgs: readonly string[] = hostedSimulatorBuildArgs,
): boolean {
  try {
    return (
      readFileSync(path.join(root, markerPath), "utf8") ===
      buildCertificate(root, toolchain, buildArgs)
    );
  } catch {
    return false;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const command = process.argv[2];
  if (command === "args") console.log(hostedSimulatorBuildArgs.join("\n"));
  else {
    const toolchain = execFileSync("xcodebuild", ["-version"], {
      encoding: "utf8",
    }).trim();
    if (command === "key")
      console.log(simulatorBuildFingerprint(root, toolchain));
    else if (command === "verify")
      process.exitCode = hasMatchingSimulatorBuild(root, toolchain) ? 0 : 1;
    else if (command === "stamp" && process.argv[3])
      stampSimulatorBuild(root, toolchain, process.argv[3]);
    else
      throw new Error(
        "Usage: apple-simulator-build-cache.ts args|key|verify|stamp <pre-build-key>",
      );
  }
}
