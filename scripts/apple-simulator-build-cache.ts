// Certifies a compiled simulator app only after dependency resolution. This
// guard is independent of DerivedData's incremental-build heuristics.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestFiles, walkFiles } from "./lib/tree-digest.ts";

const bundlePath =
  "apps/apple/DerivedData/Build/Products/Debug-iphonesimulator/Cubby.app";
const markerPath = "apps/apple/DerivedData/cubby-simulator-build.json";
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
  "apps/apple/Cubby.xcodeproj/project.pbxproj",
  "apps/apple/Cubby.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
];
const buildDrivers = [
  "scripts/apple-check.sh",
  "apps/apple/scripts/prepare-project.sh",
  "apps/web/tooling/sim-e2e.ts",
  ".github/workflows/ci.yaml",
  "scripts/apple-simulator-build-cache.ts",
];

export function simulatorBuildFingerprint(
  root: string,
  toolchain: string,
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
  return digestFiles(root, [...new Set(inputs)].sort(), {
    seed: `simulator-app-v1:Debug:arm64:batch:${toolchain}`,
    links: true,
  });
}

function buildCertificate(root: string, toolchain: string) {
  const bundle = path.join(root, bundlePath);
  for (const file of ["Cubby", "Info.plist"]) {
    if (!existsSync(path.join(bundle, file)))
      throw new Error(`Simulator app is incomplete: ${file}`);
  }
  return JSON.stringify({
    schemaVersion: 1,
    inputs: simulatorBuildFingerprint(root, toolchain),
    bundle: digestFiles(bundle, walkFiles(bundle, { includeSymlinks: true }), {
      links: true,
    }),
  });
}

export function stampSimulatorBuild(
  root: string,
  toolchain: string,
  expected: string,
): void {
  if (simulatorBuildFingerprint(root, toolchain) !== expected) {
    throw new Error("Simulator build inputs changed during compilation");
  }
  writeFileSync(path.join(root, markerPath), buildCertificate(root, toolchain));
}

export function hasMatchingSimulatorBuild(
  root: string,
  toolchain: string,
): boolean {
  try {
    return (
      readFileSync(path.join(root, markerPath), "utf8") ===
      buildCertificate(root, toolchain)
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
  const toolchain = execFileSync("xcodebuild", ["-version"], {
    encoding: "utf8",
  }).trim();
  const command = process.argv[2];
  if (command === "key")
    console.log(simulatorBuildFingerprint(root, toolchain));
  else if (command === "verify")
    process.exitCode = hasMatchingSimulatorBuild(root, toolchain) ? 0 : 1;
  else if (command === "stamp" && process.argv[3])
    stampSimulatorBuild(root, toolchain, process.argv[3]);
  else
    throw new Error(
      "Usage: apple-simulator-build-cache.ts key|verify|stamp <pre-build-key>",
    );
}
