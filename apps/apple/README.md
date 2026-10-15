# Cubby native (iOS + macOS)

For a speed-first choice between focused Swift tests, the headless native loop,
SwiftUI previews, simulator exploration, recorded E2E, and a real iPhone, see
[Fast native iteration](ITERATION.md).

SwiftUI household workflows backed by CubbyKit, the generated HTTP client, and
shared Rust computation. Agent rules, including the generated-file list, live in
[AGENTS.md](AGENTS.md). The app includes Today, catalog/search, capture/recount,
photos, Garden, links, and App Intents. See [DESIGN.md](DESIGN.md) for native UX
contracts and [the backlog](../../docs/todos.md) for deeper inventory and web parity.

## Toolchain and device requirements

Native builds require Xcode 27 with Swift 6.4 or newer and target iOS/macOS 27.
The image-description implementation must compile in every build; runtime
Apple Intelligence and vision availability remain device-dependent. Settings →
This device reports the current image-description availability reason.
Photo semantic reranking maps OS 27 model, session, and parsing errors to its
existing deterministic fallback categories; cancellation and unrelated errors
propagate unchanged.
GitHub runner and toolchain selection live in the Apple workflows and the shared
`setup-apple` action.

## Build order

Run `pnpm apple gen` or the appropriate `pnpm apple <command>`: the launcher
prepares generated contracts, the cached Rust xcframework/UniFFI shim, and the
Xcode project in dependency order. Outputs are gitignored. The
[generated-file rules](AGENTS.md#generated-files-read-only) own their inputs.
Direct `build-rust.sh --targets sim` is useful for a one-slice FFI iteration;
restore all slices before a Mac/CLI build. The first GUI build asks to trust
OpenAPIGenerator; command-line builds skip package-plugin validation.
The OpenAPI typed-record keep-list retains schemas decoded from generic kernel
rows. Its reachability check allows those roots alongside HTTP paths, replacing
Redocly's path-only unused-component rule.

For archive symbolication, install `getsentry/tools/sentry-cli` and put the org
auth token in `~/.sentryclirc`. Only the archive phase needs it; a missing CLI
or token warns rather than fails ordinary builds.

If you see the literal error text `artifact of binary target 'CubbyFFIBinary' not found`, the
xcframework hasn't been built yet — prepare the native artifacts first.

The shared `scripts/ensure.ts apple-ffi` path fingerprints Rust contents and
restores the full xcframework/Swift shim from Nx. An incomplete artifact must
not be treated as ready merely because a fingerprint matches.

## Running

`pnpm apple <command>` from the repo root ([scripts/apple.ts](../../scripts/apple/apple.ts)) runs the
build order above lazily (the xcframework from the Nx cache; xcodegen with `--use-cache`, so a
`project.yml` edit regenerates and an unchanged spec is a no-op), prints each step's wall-clock
time, and then:

- `pnpm apple cli chatgpt connect --base-url https://cubby.example.com` — macOS
  ChatGPT plan setup, reusing the stored Cubby login and shared CubbyKit OAuth flow.
- `pnpm apple cli <args…>` — incremental `swift build` of the `cubby` CLI and run it
- `pnpm apple cli auth login` — approve sign-in in the running Mac app; the CLI
  stores a copy of the app's session in its file store (pass `--email` for password sign-in)
- `pnpm apple cli photo analyze <file> --json` — on-device Vision/routing debug dump for a local
  image, no network or auth
- `pnpm apple cli companion [--once] [--verbose]` — run the app's image-processing companion
  worker headless (see below)
- `pnpm apple mac` — build `Cubby-macOS` into `apps/apple/DerivedData` and `open` the `.app`
- `pnpm apple ios [--device <name>]` — build `Cubby-iOS`, install and launch on the paired
  iPhone via `devicectl` (phone must be unlocked)
- `pnpm apple sim [--sim <name>]` — same on the booted (or first iPhone) simulator
- `pnpm apple gen` / `pnpm apple test` — the generators in order / `swift test`

Add `--timing` to `mac`, `ios`, or `sim` for the full build log and Xcode's task timing
summary. Without it, each command still prints the wall-clock time of each build/install step.

XcodeGen configures Xcode's GUI DerivedData location inside each checkout at
`apps/apple/DerivedData/Cubby`, so removing a worktree also removes its GUI build
artifacts. The command-line app builds retain `apps/apple/DerivedData`; GUI and
command-line outputs are separate, and compiled outputs stay isolated between
worktrees. Existing global DerivedData is not moved or deleted by generation.
Local Swift package commands disable the index store, matching CI; Xcode GUI
indexing stays enabled. Regenerating the project applies the location setting
while preserving other workspace preferences.

None of these attach a debugger; for breakpoints use the Xcode schemes below.

macOS Debug installs `/Applications/Cubby Dev.app` alongside the Release/TestFlight
`Cubby.app`. Its bundle ID, `cubby-dev` callback scheme, Keychain services,
installation identity, defaults, and local caches are separate. Dev requests
an ephemeral Google browser session to keep its transfer cookies separate
from a production sign-in. Both variants
use the configured Cubby server. iOS keeps its existing identity in Debug and
Release. `packages/shared/src/apple-app-identity.ts` owns the identities;
generation emits the Xcode settings and Swift values from that declaration.
The development launcher verifies the installed Dev app's signing requirement
before replacement, preserving its macOS privacy approvals across rebuilds.
The Debug CLI's app-approved sign-in opens Dev; a Release CLI opens production.
Site universal links and password autofill remain associated with production;
Dev navigation uses `cubby-dev` links.
Google sign-in in Dev requires the web deployment's callback-scheme support;
deploy that support before using Dev's Google flow. Password sign-in does not
use the browser callback.

### Headless companion (`cubby companion`)

`cubby companion` runs the same `CompanionImageWorker`, executor, and durable outbox as the app,
using the session from `cubby auth login` (an API key cannot open the socket). It registers as
its own device: the id lives in `~/Library/Application Support/Cubby/companion-device-id`,
because the app's id is a data-protection Keychain item the ad-hoc-signed CLI cannot read, and
sharing one id would merge two sockets into one device. Concurrent first starts all get the same
id, the id file is owner-only (0600), and a damaged id file is an error, not a new device. Its
outbox is namespaced `cubby-cli-<host>`, apart from the app's. Only one `cubby companion` process
can use an outbox file at a time, because two processes rewriting one outbox could erase each
other's unacknowledged results. This is enforced with a `flock` on `<outbox file>.lock`. The lock
is derived from the outbox's own sanitized, truncated path, so two hosts that map to one outbox
also share its lock. A second invocation exits with a message.

At startup it prints whether Foundation Models can describe images in this process and, if not,
the exact reason (`SystemLanguageModel.default.availability` or a missing `.vision` capability).
That value is what the hello advertises as `actualImageDescription.available`. After that it
prints each worker phase change and one line per job: kind, job id, outcome, reason, duration.
`--once` exits after the worker has been connected for `--idle-seconds` (default 10) with no
outstanding job and no unacknowledged result. A job counts as outstanding while it is queued,
running, or being recorded, and it stays outstanding across a reconnect. It exits 1 if any job
failed or if it stays disconnected for `--connect-timeout` (default 30), even while a job runs.
Without `--once` it runs until SIGINT/SIGTERM, then gives outstanding jobs and acknowledgements up
to 10s before it stops. On a signal the worker stops starting new commands. Either exit happens
only after a check that first closes command acceptance, so no job can start between "settled"
and stop. Results that are
still unacknowledged stay in the outbox and replay on the next connection.

On hello and after each result, the server hands the companion the next pending or
`waiting_for_device` job it can run, so `--once` drains a backlog one job at a time. A job that
just found no device backs off for a minute before it can be claimed again, so a quiet
`--once` run right after such a miss does not prove the queue is empty.

To keep it resident, build a copy outside the worktree's `.build` and load a user agent. For
example, save `~/Library/LaunchAgents/com.example.cubby-companion.plist` with:

```xml
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.cubby-companion</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/cubby</string><string>companion</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/cubby-companion.log</string>
  <key>StandardErrorPath</key><string>/tmp/cubby-companion.log</string>
</dict></plist>
```

Then run `launchctl bootstrap gui/$(id -u) <plist>`. Use `launchctl bootout` to stop it.
launchd's SIGTERM-to-SIGKILL window (20s by default) is longer than the 10s stop grace.

## Verification

- `pnpm apple check` runs native formatting, probes cached CubbyKit host tests
  and iOS simulator compilation, then prepares FFI and runs only misses.
  Use `pnpm apple check host`, `app`, or `lint` for one scope. A pass is cached
  for its input hash, and CI replays it on a PR with the same declared input hash.
- `pnpm apple test` runs package tests only. It does **not** run the hosted app tests.
- Hosted CI runs formatting separately as `Apple lint` without FFI setup,
  and native compilation as parallel macOS jobs: `Apple host tests`
  (`apple:host-tests`, CubbyKit's package tests on the macOS host, no
  simulator) and `Apple simulator build` (`apple:simulator-build`, a
  generic-simulator `xcodebuild build` with no tests).
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

See [release policy and manual dispatch](../../docs/ci.md#apple-testflight-release).
Versions come from the shared compatibility declaration; completed-upload tags
are maintained by the release workflow.

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
