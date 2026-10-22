import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, command, rustFingerprint } from "./rust-fingerprint.ts";

export function prepareWasm(mode: string | undefined, runTarget: () => void) {
  // wasm-pack accepts only --release; workspace member profiles are ignored.
  // Fingerprinting and building use these same settings.
  process.env.CARGO_TARGET_DIR ??= join(homedir(), ".cache/cubby/cargo-target");
  Object.assign(process.env, {
    CARGO_PROFILE_RELEASE_OPT_LEVEL: "z",
    CARGO_PROFILE_RELEASE_LTO: "true",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
    CARGO_PROFILE_RELEASE_PANIC: "abort",
    CARGO_PROFILE_RELEASE_INCREMENTAL: "false",
  });
  const fingerprint = () => {
    const tools = [
      command("wasm-pack", ["--version"]),
      readFileSync(fileURLToPath(import.meta.url), "utf8"),
      readFileSync(join(ROOT, "scripts/ensure.ts"), "utf8"),
      readFileSync(join(ROOT, "packages/wasm/package.json"), "utf8"),
      readFileSync(join(ROOT, "packages/wasm/.gitignore"), "utf8"),
      readFileSync(join(ROOT, "packages/wasm/workerd.js"), "utf8"),
    ];
    try {
      tools.push(command("wasm-opt", ["--version"]));
    } catch {
      tools.push("wasm-pack-managed optimizer");
    }
    return rustFingerprint(
      join(ROOT, "Cargo.toml"),
      ["recipebridge", "recipebridge-cookbook"],
      tools,
      ["recipebridge/default", "recipebridge/wasm"],
    );
  };
  if (mode === "--fingerprint") console.log(fingerprint());
  else if (mode === "--build") {
    for (const [output, source, flags] of [
      ["worker", "recipebridge", ["--", "--features", "wasm"]],
      [
        "browser",
        "recipebridge",
        ["--", "--no-default-features", "--features", "wasm"],
      ],
      ["cookbook", "cookbook-wasm", []],
    ] as const) {
      execFileSync(
        "wasm-pack",
        [
          "build",
          "--no-pack",
          "--out-dir",
          join(ROOT, "packages/wasm", output),
          join(ROOT, source),
          ...flags,
        ],
        { cwd: ROOT, stdio: "inherit" },
      );
    }
  } else runTarget();
}
