import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { release } from "node:os";
import { fileURLToPath } from "node:url";

export function webEnvironment(
  overrides: { platform?: string; node?: string; ci?: string } = {},
) {
  return JSON.stringify({
    platform: overrides.platform ?? process.platform,
    arch: process.arch,
    image: process.env.ImageVersion || release(),
    node: overrides.node ?? process.version,
    ci: overrides.ci ?? process.env.CI ?? "",
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

const capture = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8" }).trim();

export function appleEnvironment(
  platform = process.platform,
  observed = process.env.CUBBY_APPLE_ENVIRONMENT ?? "",
  run = capture,
) {
  if (platform !== "darwin") {
    if (!observed)
      throw new Error(
        "Apple cache lookup requires an observed Mac environment",
      );
    const value = JSON.parse(observed);
    if (
      value.platform !== "darwin" ||
      !["arch", "xcode", "swift", "macos", "sdk", "rust"].every(
        (key) => typeof value[key] === "string" && value[key],
      )
    )
      throw new Error("Invalid observed Mac environment");
    return observed;
  }
  // Explicit +channel avoids installing the target/component list merely to
  // discover the compiler on a lightweight runner.
  const toolchain = readFileSync(
    new URL("../rust-toolchain.toml", import.meta.url),
    "utf8",
  );
  const channel = /^\s*channel\s*=\s*"([^"]+)"/mu.exec(toolchain)?.[1];
  if (!channel) throw new Error("Missing Rust toolchain channel");
  return JSON.stringify({
    platform: "darwin",
    arch: run("uname", ["-m"]),
    xcode: run("xcodebuild", ["-version"]),
    swift: run("xcrun", ["swift", "--version"]),
    macos: run("sw_vers", ["-productVersion"]),
    sdk: run("xcodebuild", ["-version", "-sdk"]),
    rust: run("rustc", [`+${channel}`, "-V"]),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (target === "apple") console.log(appleEnvironment());
  else if (target === "web") console.log(webEnvironment());
  else if (target === "swift")
    console.log(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        swift: capture("swift", ["--version"]),
      }),
    );
  else if (target === "ffi")
    console.log(
      JSON.stringify({
        profile: process.env.CUBBY_FFI_PROFILE || "release",
        warnings: process.env.CARGO_BUILD_WARNINGS || "warn",
        rustflags: process.env.RUSTFLAGS || "",
        encoded: process.env.CARGO_ENCODED_RUSTFLAGS || "",
      }),
    );
  else throw new Error(`Unknown CI environment target: ${target}`);
}
