# Cubby native (iOS + macOS)

SwiftUI household workflows backed by CubbyKit, the generated HTTP client, and
shared Rust computation. The app includes Today, catalog/search, capture/recount,
photos, Garden, links, and App Intents. See [DESIGN.md](DESIGN.md) for native UX
contracts and [the backlog](../../docs/todos.md) for deeper inventory and web parity.

## Build order

1. `apps/apple/scripts/build-rust.sh` — builds `cubby-ffi` for iOS device/sim + macOS, generates
   Swift bindings, stages `CubbyKit/Frameworks/CubbyFFI.xcframework` (gitignored) and commits
   `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift`.
2. `apps/apple/scripts/generate-openapi.sh` — runs the CLI `swift-openapi-generator` against
   `apps/web/src/lib/generated/http-openapi.gen.json`, writes committed sources under
   `CubbyKit/Sources/CubbyAPI/{Types,Client}.swift`. That output is its own SPM target so a
   hand-written CubbyKit edit no longer recompiles ~58k generated lines; app code names its
   types through the aliases `pnpm generate` writes to `CubbyKit/Generated/APITypes.swift`, with
   the branded codes and `PlainDate` supplied by the tiny `CubbyAPISupport` target.
   `generate-openapi.sh --check` fails when the committed client is stale.
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

## Generated files (read-only here)

- `CubbyKit/Sources/CubbyKit/Generated/{EntityCatalog,OperationRoutes,EntityOperations,APITypes}.swift`
  and `CubbyKit/Sources/CubbyAPISupport/Generated/EntityKey.swift` — emitted by
  `scripts/generator/` from the entity spine and the OpenAPI document. Regenerate with
  `pnpm generate` from the repo root.
- `CubbyKit/Sources/CubbyAPI/*.swift` — the whole `CubbyAPI` target is swift-openapi-generator's
  output (`Client.swift` plus `Types*.swift`). Regenerate with
  `apps/apple/scripts/generate-openapi.sh`; `generate-openapi.sh --check` fails when stale.
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
- `pnpm apple cli photo analyze <file> --json` — on-device Vision/routing debug dump for a local
  image, no network or auth
- `pnpm apple mac` — build `Cubby-macOS` into `apps/apple/DerivedData` and `open` the `.app`
- `pnpm apple ios [--device <name>]` — build `Cubby-iOS`, install and launch on the paired
  iPhone via `devicectl` (phone must be unlocked)
- `pnpm apple sim [--sim <name>]` — same on the booted (or first iPhone) simulator
- `pnpm apple gen` / `pnpm apple test` — the generators in order / `swift test`

None of these attach a debugger; for breakpoints use the Xcode schemes below.

## Verification

- `pnpm apple check` runs native formatting, CubbyKit package tests, generated API
  drift checks, and an iOS simulator build.
- `pnpm apple test` runs package tests only. It does **not** run the hosted app tests.
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

The `Apple TestFlight` GitHub Actions workflow archives and uploads both the iOS and native macOS
apps to the shared App Store Connect record. A release tag must be an exact `vMAJOR.MINOR.PATCH`
tag on the current `main` commit, and the `CI` workflow must already have succeeded for that exact
commit. For example:

```sh
git switch main
git pull --ff-only
git tag v1.2.3
git push origin v1.2.3
```

The tag supplies `MARKETING_VERSION`. Build numbers are generated without editing `project.yml`:
iOS uses `<commit-count>.1.<run-attempt>` and macOS uses
`<commit-count>.2.<run-attempt>`. Rerunning a partially failed release therefore produces fresh
build numbers for both platforms. Both archives must finish before either upload starts, and every
uploaded archive has `testFlightInternalTestingOnly` set, so it cannot later be promoted to external
TestFlight or the App Store.

Use the workflow's manual dispatch with a `MAJOR.MINOR.PATCH` version to validate the complete
certificate, profile, archive, and export path. Manual runs save the signed exports and dSYMs as a
workflow artifact but never upload a build to App Store Connect.

### One-time Apple and GitHub setup

The App Store Connect app with Apple ID `6811439338` must have iOS and macOS platforms enabled for
the `com.nickysemenza.cubby` bundle identifier. Its internal `household` TestFlight group keeps
automatic Xcode-build distribution enabled. In Certificates, Identifiers & Profiles, enable
Associated Domains for the identifier and create exactly these active profiles:

- `AppStore com.nickysemenza.cubby iOS` (`IOS_APP_STORE`)
- `AppStore com.nickysemenza.cubby macOS` (`MAC_APP_STORE`)

Configure these repository Actions secrets:

- `APP_STORE_CONNECT_API_KEY_P8` — the App Store Connect API key's complete `.p8` contents
- `APP_STORE_CONNECT_KEY_ID` — the API key ID
- `APP_STORE_CONNECT_ISSUER_ID` — the API issuer ID
- `APPLE_DISTRIBUTION_P12_BASE64` — base64 of one `.p12` containing the private keys and
  certificates for both `Apple Distribution` and `Mac Installer Distribution`
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
