import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, command, rustFingerprint } from "./rust-fingerprint.ts";

export function appleFfiFingerprint(
  profile = process.env.CUBBY_FFI_PROFILE ?? "release",
  targets = process.env.CUBBY_FFI_TARGETS ?? "all",
) {
  if (!["all", "sim", "device", "mac"].includes(targets))
    throw new Error(
      `CUBBY_FFI_TARGETS must be one of all|sim|device|mac, got ${targets}`,
    );
  return rustFingerprint(
    join(ROOT, "Cargo.toml"),
    ["cubby-ffi"],
    [
      readFileSync(fileURLToPath(import.meta.url), "utf8"),
      readFileSync(join(ROOT, "scripts/ensure.ts"), "utf8"),
      readFileSync(join(ROOT, "apps/apple/scripts/build-rust.sh"), "utf8"),
      command("xcodebuild", ["-version"]),
      command("uname", ["-m"]),
      `profile=${profile}`,
      `targets=${targets}`,
    ],
    ["cubby-ffi/cli"],
  );
}

export function prepareAppleFfi(
  mode: string | undefined,
  runTarget: () => void,
) {
  const profile = process.env.CUBBY_FFI_PROFILE ?? "release";
  const targets = process.env.CUBBY_FFI_TARGETS ?? "all";
  const key = appleFfiFingerprint(profile, targets);
  const marker = join(
    ROOT,
    "apps/apple/CubbyKit/Frameworks/CubbyFFI.xcframework/.fingerprint",
  );
  if (mode === "--fingerprint") console.log(key);
  else if (mode === "--build") {
    execFileSync(
      join(ROOT, "apps/apple/scripts/build-rust.sh"),
      ["--profile", profile, "--targets", targets],
      { cwd: ROOT, stdio: "inherit" },
    );
    writeFileSync(marker, `${key}\n`);
  } else if (
    existsSync(
      join(ROOT, "apps/apple/CubbyKit/Sources/CubbyFFI/cubby_ffi.swift"),
    ) &&
    existsSync(marker) &&
    readFileSync(marker, "utf8").trim() === key
  ) {
    // Avoid touching shim mtimes and triggering native recompilation on replay.
    console.log("apple-ffi: CubbyFFI.xcframework is current");
  } else runTarget();
}
