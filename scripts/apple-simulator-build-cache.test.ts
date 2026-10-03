// A stale or corrupted compiled app must never bypass the native build.
// Harness/workflow-only changes must retain a certified app; changed compiler
// arguments must invalidate it even when all source files remain identical.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  simulatorBuildFingerprint,
  stampSimulatorBuild,
  hasMatchingSimulatorBuild,
} from "./apple-simulator-build-cache.ts";

const inputs = [
  "apps/apple/App/Screen.swift",
  "apps/apple/App/Assets.xcassets/icon.png",
  "apps/apple/CubbyKit/Sources/CubbyAPI/openapi.json",
  "apps/apple/CubbyKit/Frameworks/CubbyFFI.xcframework/.fingerprint",
  "apps/apple/CubbyKit/Frameworks/CubbyFFI.xcframework/library.a",
  "apps/apple/CubbyKit/Package.swift",
  "apps/apple/CubbyKit/Package.resolved",
  "apps/apple/project.yml",
  "apps/apple/Cubby.xcodeproj/project.pbxproj",
  "apps/apple/SourcePackages/workspace-state.json",
];
const bundle =
  "apps/apple/DerivedData/Build/Products/Debug-iphonesimulator/Cubby.app";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cubby-simulator-cache-"));
  const write = (file: string, bytes: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  };
  for (const input of inputs) write(input, "synthetic build input");
  write(
    inputs.at(-1)!,
    JSON.stringify({ version: 6, object: { dependencies: [], artifacts: [] } }),
  );
  write(`${bundle}/Cubby`, "synthetic executable");
  write(`${bundle}/Info.plist`, "synthetic app settings");
  return {
    root,
    write,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("retains a certified app through harness and workflow edits", () => {
  const f = fixture();
  try {
    f.write("apps/web/tooling/sim-e2e.ts", "synthetic harness before");
    f.write(".github/workflows/ci.yaml", "synthetic workflow before");
    f.write("scripts/apple-simulator-build-cache.ts", "synthetic build driver");
    const key = simulatorBuildFingerprint(f.root, "synthetic Xcode");
    stampSimulatorBuild(f.root, "synthetic Xcode", key);
    f.write("apps/web/tooling/sim-e2e.ts", "synthetic harness after");
    f.write(".github/workflows/ci.yaml", "synthetic workflow after");
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode"), true);
    f.write(
      "scripts/apple-simulator-build-cache.ts",
      "changed synthetic build driver",
    );
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode"), false);
  } finally {
    f.dispose();
  }
});

test("binds a certificate to the actual compiler arguments", () => {
  const f = fixture();
  try {
    const args = ["-configuration", "Debug", "ARCHS=arm64"];
    const key = simulatorBuildFingerprint(f.root, "synthetic Xcode", args);
    stampSimulatorBuild(f.root, "synthetic Xcode", key, args);
    assert.equal(
      hasMatchingSimulatorBuild(f.root, "synthetic Xcode", args),
      true,
    );
    const changed = ["-configuration", "Release", "ARCHS=arm64"];
    assert.equal(
      hasMatchingSimulatorBuild(f.root, "synthetic Xcode", changed),
      false,
    );
    assert.throws(
      () => stampSimulatorBuild(f.root, "synthetic Xcode", key, changed),
      /changed/,
    );
  } finally {
    f.dispose();
  }
});

test("reuses a matching build but refuses changed native inputs and toolchains", () => {
  const f = fixture();
  try {
    const key = simulatorBuildFingerprint(f.root, "synthetic Xcode A");
    stampSimulatorBuild(f.root, "synthetic Xcode A", key);
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode A"), true);
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode B"), false);
    for (const input of inputs) {
      f.write(input, "changed synthetic input");
      assert.equal(
        hasMatchingSimulatorBuild(f.root, "synthetic Xcode A"),
        false,
        input,
      );
      f.write(input, "synthetic build input");
    }
  } finally {
    f.dispose();
  }
});

test("refuses altered bundle resources and incomplete dependency resolution", () => {
  const f = fixture();
  try {
    stampSimulatorBuild(
      f.root,
      "synthetic Xcode",
      simulatorBuildFingerprint(f.root, "synthetic Xcode"),
    );
    f.write(`${bundle}/Info.plist`, "changed app settings");
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode"), false);
    f.write(`${bundle}/Info.plist`, "synthetic app settings");
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode"), true);
    rmSync(path.join(f.root, inputs.at(-1)!));
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode"), false);
  } finally {
    f.dispose();
  }
});

test("refuses to certify inputs changed during compilation", () => {
  const f = fixture();
  try {
    const before = simulatorBuildFingerprint(f.root, "synthetic Xcode");
    f.write(inputs[0]!, "changed while compiling");
    assert.throws(
      () => stampSimulatorBuild(f.root, "synthetic Xcode", before),
      /changed/,
    );
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode"), false);
  } finally {
    f.dispose();
  }
});

test("package metadata ordering does not invalidate a build, but revisions do", () => {
  const f = fixture();
  const graph = inputs.at(-1)!;
  try {
    const first = {
      packageRef: { identity: "synthetic-a" },
      state: { revision: "one" },
    };
    const second = {
      packageRef: { identity: "synthetic-b" },
      state: { revision: "two" },
    };
    f.write(
      graph,
      JSON.stringify({
        version: 6,
        object: { dependencies: [first, second], artifacts: [] },
      }),
    );
    const key = simulatorBuildFingerprint(f.root, "synthetic Xcode");
    f.write(
      graph,
      JSON.stringify(
        {
          object: { artifacts: [], dependencies: [second, first] },
          version: 6,
        },
        null,
        2,
      ),
    );
    assert.equal(simulatorBuildFingerprint(f.root, "synthetic Xcode"), key);
    stampSimulatorBuild(f.root, "synthetic Xcode", key);
    first.state.revision = "changed";
    f.write(
      graph,
      JSON.stringify({
        version: 6,
        object: { dependencies: [first, second], artifacts: [] },
      }),
    );
    assert.equal(hasMatchingSimulatorBuild(f.root, "synthetic Xcode"), false);
  } finally {
    f.dispose();
  }
});
