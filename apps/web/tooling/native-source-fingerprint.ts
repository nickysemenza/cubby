import path from "node:path";
import { appleFfiFingerprint } from "cubby/tooling/apple-ffi";
import { digestFiles, walkFiles } from "cubby/tooling/tree-digest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const appleRoot = path.join(repoRoot, "apps/apple");

/**
 * Every input a native e2e build reads: CubbyKit sources and bundled resources,
 * the FFI framework, package pins and the Rust FFI inputs, plus the app tree and
 * project when `includeApp`. `seed` names caller build settings that change the
 * output (an e2e-only build flag).
 */
export function nativeSourceFingerprint(options: {
  includeApp: boolean;
  seed?: string;
}): string {
  const trees = [
    "CubbyKit/Sources",
    "CubbyKit/Frameworks",
    ...(options.includeApp ? ["App", "scripts"] : []),
  ];
  const files = [
    ...trees.flatMap((tree) =>
      walkFiles(path.join(appleRoot, tree), {
        skip: (name) => name === ".DS_Store",
      }),
    ),
    ...[
      "CubbyKit/Package.swift",
      "CubbyKit/Package.resolved",
      ...(options.includeApp
        ? [
            "project.yml",
            "packages.yml",
            "Cubby.xcodeproj/project.pbxproj",
            "Cubby.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
          ]
        : []),
    ].map((file) => path.join(appleRoot, file)),
  ];
  return digestFiles(appleRoot, files, {
    seed: `native-inputs-v4\0${options.seed ?? ""}\0${appleFfiFingerprint()}`,
  });
}
