# Cubby native (iOS + macOS PoC)

Vertical slice proving bearer sign-in, `swift-openapi-generator` against Cubby's OpenAPI doc,
Rust ingredient parsing via UniFFI, and VisionKit/Vision scanning — before any real screen
porting. See `/Users/nicky/.claude/plans/moonlit-juggling-finch.md` for the full plan.

## Build order

1. `apps/apple/scripts/build-rust.sh` — builds `cubby-ffi` for iOS device/sim + macOS, generates
   Swift bindings, stages `CubbyKit/Frameworks/CubbyFFI.xcframework` (gitignored) and commits
   `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift`.
2. `apps/apple/scripts/generate-openapi.sh` — runs the CLI `swift-openapi-generator` against
   `apps/web/src/lib/generated/http-openapi.gen.json`, writes committed sources under
   `CubbyKit/Sources/CubbyAPI/{Types,Client}.swift`. That output is its own SPM target so a
   hand-written CubbyKit edit no longer recompiles ~58k generated lines.
3. `xcodegen generate --spec apps/apple/project.yml` — produces `Cubby.xcodeproj` (gitignored).
4. Optional: `brew install getsentry/tools/sentry-cli` and put an org auth token in
   `~/.sentryclirc`. Only the `Upload dSYMs to Sentry` archive phase needs it (project
   `cubby-apple`; the org is derived from the token), so a TestFlight build symbolicates. A
   missing `sentry-cli` or token is a build warning, never a failure.

If you see the literal error text `artifact of binary target 'CubbyFFIBinary' not found`, the
xcframework hasn't been built yet — run step 1 (`build-rust.sh`) first.

Step 1 is wrapped by [scripts/ensure-apple-ffi.ts](../../scripts/ensure-apple-ffi.ts): the
xcframework and `cubby_ffi.swift` are outputs of the Nx-cached `apple-ffi` target
(`project.json`), keyed by the same path-independent Rust content fingerprint the WASM build uses
(`scripts/rust-fingerprint.ts`). Nx shares that cache across every worktree, so a checkout with
unchanged Rust restores both in seconds instead of recompiling the path crates for three targets;
a matching fingerprint marker inside the xcframework skips Nx entirely. `build-rust.sh` itself
always builds (cargo's fingerprints make an unchanged rerun cheap) — run it directly for one-slice
iteration (`--targets sim`). The generator build for step 2 is likewise shared across worktrees
under `~/.cache/cubby/openapi-generator-build`.

## Ownership

Another agent/workstream (W1) owns `apps/apple/scripts/build-rust.sh`,
`CubbyKit/Sources/CubbyFFI/`, `CubbyKit/Frameworks/`, and
`CubbyKit/Sources/CubbyKit/Generated/EntityCatalog.swift`. Everything else under `apps/apple/` is
owned by W2 (this package, the app targets, and the CLI harness).

## Generated files (read-only here)

- `CubbyKit/Sources/CubbyKit/Generated/EntityCatalog.swift` — emitted by
  `scripts/entity-generator/render/swift-catalog.ts` from the entity spine. Regenerate with
  `pnpm entity:generate` from the repo root.
- `CubbyKit/Sources/CubbyAPI/*.swift` — the whole `CubbyAPI` target is swift-openapi-generator's
  output (`Client.swift` plus `Types*.swift`). Regenerate with
  `apps/apple/scripts/generate-openapi.sh`; `check-openapi-drift.sh` fails when stale.
- `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift` — emitted by `uniffi-bindgen` from `cubby-ffi/`.
  Regenerate with `apps/apple/scripts/build-rust.sh`.

All are committed; hand-editing any of them fails the relevant staleness gate (for
`cubby_ffi.swift`, the pre-push check regenerates it and fails on a dirty tree).

## Running

`pnpm apple <command>` from the repo root ([scripts/apple.ts](../../scripts/apple.ts)) runs the
build order above lazily (the xcframework from the Nx cache; xcodegen with `--use-cache`, so a
`project.yml` edit regenerates and an unchanged spec is a no-op), prints each step's wall-clock
time, and then:

- `pnpm apple cli <args…>` — incremental `swift build` of the `cubby` CLI and run it
- `pnpm apple mac` — build `Cubby-macOS` into `apps/apple/DerivedData` and `open` the `.app`
- `pnpm apple ios [--device <name>]` — build `Cubby-iOS`, install and launch on the paired
  iPhone via `devicectl` (phone must be unlocked)
- `pnpm apple sim [--sim <name>]` — same on the booted (or first iPhone) simulator
- `pnpm apple gen` / `pnpm apple test` — the generators in order / `swift test`

None of these attach a debugger; for breakpoints use the Xcode schemes below.

## Verification

- `swift build --package-path apps/apple/CubbyKit`
- `swift test --package-path apps/apple/CubbyKit`
- `swift run --package-path apps/apple/CubbyKit cubby -- --help` (CLI harness; no Xcode scheme)
- `xcodegen generate --spec apps/apple/project.yml` then
  `xcodebuild -project apps/apple/Cubby.xcodeproj -scheme Cubby-iOS -destination 'generic/platform=iOS Simulator' build`
  for the app targets (needs the xcframework from step 1 first)
- The `Upload dSYMs to Sentry` phase is `runOnlyWhenInstalling`: it runs on archive only, so a
  plain build or simulator run never touches `sentry-cli`. Verify it from an archive's build log.

## Debugging on device

Launching under LLDB indexes CubbyKit's ~60k generated lines and shows a 10-30s white screen on
device. Use the `Cubby-iOS-NoDebugger` / `Cubby-macOS-NoDebugger` schemes for fast UI iteration
when you don't need breakpoints. When you do need the debugger, copy
`apps/apple/lldbinit-Xcode.example` to `~/.lldbinit-Xcode` first — it enables LLDB's on-demand
symbol loading, which cuts attach time on the regular schemes.
