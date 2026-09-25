# Cubby native (iOS + macOS)

For a speed-first choice between focused Swift tests, the headless native loop,
SwiftUI previews, simulator exploration, recorded E2E, and a real iPhone, see
[Fast native iteration](ITERATION.md).

SwiftUI household workflows backed by CubbyKit, the generated HTTP client, and
shared Rust computation. The app includes Today, catalog/search, capture/recount,
photos, Garden, links, and App Intents. See [DESIGN.md](DESIGN.md) for native UX
contracts and [the backlog](../../docs/todos.md) for deeper inventory and web parity.

## Build order

1. `apps/apple/scripts/build-rust.sh` — builds `cubby-ffi` for iOS device/sim + macOS, generates
   Swift bindings, stages `CubbyKit/Frameworks/CubbyFFI.xcframework` and
   `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift` (both gitignored).
2. `pnpm generate` (run by `pnpm install`, `pnpm apple gen` and the Xcode schemes' build
   pre-action) — writes the gitignored generated Swift: `CubbyKit/Generated/*.swift`, the
   `openapi.json` and `openapi-generator-config.yaml` that swift-openapi-generator's SwiftPM
   build plugin turns into the `CubbyAPI` target at build time, and the preview fixtures. That
   target is separate so a hand-written CubbyKit edit does not recompile ~58k generated lines;
   app code names its types through the aliases in `CubbyKit/Generated/APITypes.swift`, with the
   branded codes and `PlainDate` supplied by the tiny `CubbyAPISupport` target. The first
   Xcode build asks to trust the `OpenAPIGenerator` plugin; command-line builds pass
   `-skipPackagePluginValidation`.
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
iteration (`--targets sim`).

## Generated files (read-only here)

- `CubbyKit/Sources/CubbyKit/Generated/{EntityCatalog,OperationRoutes,EntityOperations,APITypes}.swift`,
  `CubbyKit/Sources/CubbyAPISupport/Generated/EntityKey.swift`, the `CubbyAPI` target's
  `openapi.json` + `openapi-generator-config.yaml`, and `App/Shared/Previews/Fixtures/*.json` —
  written by `scripts/generator/` (`pnpm generate`) from the entity spine and the OpenAPI document.
- The `CubbyAPI` Swift — generated at build time by the swift-openapi-generator plugin.
- `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift` — emitted by `uniffi-bindgen` from `cubby-ffi/`
  (`apps/apple/scripts/build-rust.sh`).

None is committed; edit the generator or its inputs, never the output.

## Running

`pnpm apple <command>` from the repo root ([scripts/apple.ts](../../scripts/apple.ts)) runs the
build order above lazily (the xcframework from the Nx cache; xcodegen with `--use-cache`, so a
`project.yml` edit regenerates and an unchanged spec is a no-op), prints each step's wall-clock
time, and then:

- `pnpm apple cli <args…>` — incremental `swift build` of the `cubby` CLI and run it
- `pnpm apple cli photo analyze <file> --json` — on-device Vision/routing debug dump for a local
  image, no network or auth
- `pnpm apple mac` — build `Cubby-macOS` into `apps/apple/DerivedData` and `open` the `.app`
- `pnpm apple ios [--device <name>]` — build `Cubby-iOS`, install and launch on the paired
  iPhone via `devicectl` (phone must be unlocked)
- `pnpm apple sim [--sim <name>]` — same on the booted (or first iPhone) simulator
- `pnpm apple gen` / `pnpm apple test` — the generators in order / `swift test`

Add `--timing` to `mac`, `ios`, or `sim` for the full build log and Xcode's task timing
summary. Without it, each command still prints the wall-clock time of each build/install step.

None of these attach a debugger; for breakpoints use the Xcode schemes below.

## Verification

- `pnpm apple check` runs native formatting, CubbyKit package tests, generated API
  drift checks, and an iOS simulator build (`scripts/apple-check.sh full`).
- `pnpm apple test` runs package tests only. It does **not** run the hosted app tests.
- Hosted CI runs this as two path-filtered macOS jobs instead of one: `Apple
package tests` runs `swift test --package-path apps/apple/CubbyKit
--force-resolved-versions` on the macOS host (no simulator), and `Apple
checks` runs `sh scripts/apple-check.sh ci` — the same formatting and drift
  checks, then a generic-simulator `xcodebuild build` with no tests, reusing a
  CI-cached SPM clone directory. They were one merged job that also ran
  `xcodebuild test` on a concrete simulator, but a hosted runner's first
  simulator boot cost about 6 minutes plus roughly 10 more of CPU starvation,
  so that job took 13 minutes warm; splitting it back into two is faster.
  `CubbyKit/Tests/CubbyKitTests/VisionHardware.swift`'s `.requiresVisionHardware`
  trait still matters for anyone running these tests on a simulator, e.g. via
  `xcodebuild test -scheme Cubby-iOS` locally (the scheme lists
  `package: CubbyKit/CubbyKitTests` alongside `Cubby-iOS-Tests`).
- Run the hosted iPhone tests explicitly, using a simulator ID from `xcrun simctl
list devices available`:

  ```sh
  xcodebuild -project apps/apple/Cubby.xcodeproj -scheme Cubby-iOS \
    -destination 'platform=iOS Simulator,id=<simulator-id>' \
    -derivedDataPath apps/apple/DerivedData -parallel-testing-enabled NO test
  ```

- Run Mac navigation contracts with `xcodebuild -project apps/apple/Cubby.xcodeproj
-scheme Cubby-macOS -destination 'platform=macOS,arch=arm64' test`, then interact
  with the built app.
- Avoid simultaneous builds sharing one DerivedData directory. The dSYM upload
  phase runs only when archiving; ordinary builds/tests do not upload symbols.
- UI and physical-device acceptance are separate from these gates; follow
  [DESIGN.md](DESIGN.md#acceptance).

## TestFlight releases

The `Apple TestFlight` GitHub Actions workflow runs when a `vMAJOR.MINOR.PATCH` tag is pushed at a
commit on `main`. Every run uploads both the iOS and native macOS apps to the shared App Store
Connect record; there is no dispatch or dry-run mode. The tag supplies `MARKETING_VERSION`, and
both platforms share a `<commit-count>.<run-attempt>` build number. A failed run can be retried
with `gh run rerun --failed`, which produces a fresh build number. A fix to release code uses the
next version rather than moving the failed tag.

The iOS and macOS archives build in parallel, then one downstream job exports and uploads both.
Neither platform uploads unless both archives succeed. Every export sets
`testFlightInternalTestingOnly`, so distribution is limited to internal household testers and
cannot be promoted to external TestFlight or the public App Store. See
[the release procedure](../../docs/ci.md#apple-testflight-release) for verification and failure
handling.

### One-time Apple and GitHub setup

The App Store Connect app with Apple ID `6811439338` must have iOS and macOS platforms enabled for
the `com.nickysemenza.cubby` bundle identifier. Its internal `household` TestFlight group keeps
automatic Xcode-build distribution enabled. In Certificates, Identifiers & Profiles, enable
Associated Domains for the identifier and create exactly these active profiles:

- `AppStore com.nickysemenza.cubby iOS` (`IOS_APP_STORE`)
- `AppStore com.nickysemenza.cubby.LiveActivity iOS` (`IOS_APP_STORE`, for the embedded Live
  Activity extension; register the `com.nickysemenza.cubby.LiveActivity` identifier first)
- `AppStore com.nickysemenza.cubby macOS` (`MAC_APP_STORE`)

Configure these repository Actions secrets:

- `APP_STORE_CONNECT_API_KEY_P8` — the App Store Connect API key's complete `.p8` contents
- `APP_STORE_CONNECT_KEY_ID` — the API key ID
- `APP_STORE_CONNECT_ISSUER_ID` — the API issuer ID
- `APPLE_DISTRIBUTION_P12_BASE64` — base64 of one `.p12` containing the private keys and
  certificates for both `Apple Distribution` and `Mac Installer Distribution` (the latter still
  appears as `3rd Party Mac Developer Installer` in Keychain)
- `APPLE_DISTRIBUTION_P12_PASSWORD` — the `.p12` export password
- `SENTRY_AUTH_TOKEN` — the existing org token used to upload archive dSYMs

The profiles must contain the imported Apple Distribution certificate and the Associated Domains
entitlement. Keep the certificate and API key only in GitHub secrets; never commit their files or
paste their values into workflow YAML.

## Debugging on device

Launching under LLDB indexes CubbyKit's ~60k generated lines and shows a 10-30s white screen on
device. Use the `Cubby-iOS-NoDebugger` / `Cubby-macOS-NoDebugger` schemes for fast UI iteration
when you don't need breakpoints. When you do need the debugger, copy
`apps/apple/lldbinit-Xcode.example` to `~/.lldbinit-Xcode` first — it enables LLDB's on-demand
symbol loading, which cuts attach time on the regular schemes.
