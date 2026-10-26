# Cubby native (iOS + macOS)

For a speed-first choice between focused Swift tests, the headless native loop,
SwiftUI previews, simulator exploration, recorded E2E, and a real iPhone, see
[Fast native iteration](ITERATION.md).

SwiftUI household workflows backed by CubbyKit, the generated client for the
shared operation POST transport, and shared Rust computation. Agent rules, including the generated-file list, live in
[AGENTS.md](AGENTS.md). The app includes Today, catalog/search, capture/recount,
photos, Garden, links, and App Intents. See [DESIGN.md](DESIGN.md) for native UX
contracts and [GitHub Issues](https://github.com/nickysemenza/cubby/issues) for deeper inventory and web parity.

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
restore all slices before a Mac/CLI build.
After adding or removing app/test Swift files, run `pnpm apple gen` before a
direct Xcode build. Low-level Nx build targets expect artifacts prepared by
`pnpm apple check` locally or the shared setup action in CI.
The native typed-record keep-list retains schemas still decoded from generic kernel
rows. The [native model pipeline](CubbyKit/Sources/CubbyAPI/README.md) owns generation
and codec rules.

For archive symbolication, install `getsentry/tools/sentry-cli` and put the org
auth token in `~/.sentryclirc`. Only the archive phase needs it; a missing CLI
or token warns rather than fails ordinary builds.

If you see the literal error text `artifact of binary target 'CubbyFFIBinary' not found`, the
xcframework hasn't been built yet — prepare the native artifacts first.

The shared `scripts/ensure.ts apple-ffi` path fingerprints Rust contents and
restores the full xcframework/Swift shim from Nx. An incomplete artifact must
not be treated as ready merely because a fingerprint matches.

## Running

iOS photo matching and library sync register their background-task launch callbacks
on the main queue to match their `@MainActor` isolation. Background execution
describes the app lifecycle; it does not require callback delivery on a background
thread. The handlers retain their asynchronous work and expiration cancellation.

`pnpm apple <command>` from the repo root ([tooling/apple.ts](tooling/apple.ts)) runs the
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

CLI API failures exit with status 1 and print the HTTP status, operation, server
code/message, reason, request ID, validation issues and response diagnostics to
stderr. Non-JSON responses retain their text, including intermediary rejection
pages. Credential values and labelled request payloads are redacted. A failed
write is not automatically retried; inspect its diagnostics and verify the
stored outcome before deciding whether to send it again.

XcodeGen points GUI and command-line app builds at the same checkout-local
`apps/apple/DerivedData`. Regenerate with `pnpm apple gen` to apply it. Different
worktrees retain separate build databases/products and package checkouts, so they
can build concurrently; avoid overlapping builds within one checkout.

Xcode compilation results use a shared content-addressed cache at
`~/Library/Caches/cubby/xcode`, with Xcode-managed trimming to a 10 GB limit.
Project settings enable it for GUI app targets; the existing Apple command also
passes it to package targets for app launches and native checks. This saves
repeated compiler-cache storage and lets compatible compilations be reused across
worktrees. Package pins and compiler inputs still decide reuse; a fresh worktree
must resolve its own package graph, generate sources, and link its own products.
SwiftPM CLI builds/tests keep their own `.build` outputs and SwiftPM's normal
shared download cache. Mutable package checkout directories are never shared
between worktrees. Launches and checks use one `apps/apple/SourcePackages` per
checkout; GUI package resolution remains managed by Xcode.

CI checks and TestFlight archives retain their existing DerivedData-local compiler
cache paths for hosted cache restore/save. Local GUI indexing stays enabled;
command-line builds disable the index store.

`pnpm apple clean` previews allocated KiB for this checkout's `DerivedData`,
`SourcePackages`, and `CubbyKit/.build`. Stop builds and close Xcode, then use
`pnpm apple clean --apply` to delete those rebuildable directories. Cleanup refuses
symlinked paths and directories with open files, and retains source files,
generated FFI, global caches, archives, simulator data, and other worktrees.
The open-file check is a guard, not synchronization: do not start a build during
cleanup. Existing GUI data under `DerivedData/Cubby` is included in that preview;
generation does not move or delete old artifacts. Removing a worktree still
removes its local build artifacts, while the shared compiler cache survives.

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
using the session from `cubby auth login` (an API key cannot subscribe to the doorbell). It registers as
its own device: the id lives in `~/Library/Application Support/Cubby/companion-device-id`,
because the app's id is a data-protection Keychain item the ad-hoc-signed CLI cannot read, and
sharing one id would merge two companions into one device. Concurrent first starts all get the same
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

## Activity

While the companion processes images, one **Processing image queue** activity feeds
Activity, the macOS sidebar and the iOS bottom accessory through the shared activity
summary and aggregate progress. It shows **N running · M done**, plus **about X at this
pace** when `job.deviceBacklog` supplies an ETA. Tapping opens Activity. User-started
work keeps first priority.

On iOS the same queue activity appears on the Lock Screen and Dynamic Island, with
its counts, progress and server ETA. It ends when processing stops. A Live Activity
only displays progress; it grants no background execution. Image processing requires
the foreground, a granted **Process queue now** continued-processing task, or the
opportunistic overnight charging window described below.

Local work and photo-import Runs use the same `DeviceWorkWidget` presentation,
with a symbol for the work kind and an attention symbol in every Dynamic Island
size. Their feeds stay separate: the device owns local progress; the initiating
install registers each photo-import batch for server ActivityKit pushes. When the
app observes completion, failure or cancellation, imports end with their final
state immediately in the Dynamic Island and retain it for 20 minutes on the Lock
Screen. Server end pushes retain it for 15 minutes; a server failure delivered as
an update still requires foreground reconciliation to end the Activity. Retrying
a failed batch can start a fresh Activity. A Control Center **Capture** button opens the existing
scanner and photo import tools; it does not start processing without a selection.

Other server Run purposes still need the server registration/lifecycle work in
[#2207](https://github.com/nickysemenza/cubby/issues/2207). APNs delivery, locked-device
updates, Control Center launch and dismissal require real-device verification in
[#3329](https://github.com/nickysemenza/cubby/issues/3329); unsigned builds and unit
tests establish only compilation, payload and routing behavior.

### Companion worker lifecycle (app and CLI)

Describe-image and subject-lift commands share one pool of slots
(`CompanionImageConcurrency`); the worker asks for all free slots in one batch pull (`maxCommands`, up to 16), so the server keeps no
per-device limit. Automatic is 8 on Mac and 4 on iPhone/iPad. Settings › Image work sets an
explicit 1–16 per device (UserDefaults `imageWork.concurrentJobs`, 0 = Automatic), applied on the
next pull without a restart; `cubby companion --jobs N` sets it for the CLI.

A queue session starts with the first accepted command after idle and lasts through
slot refills and result recording until the drain settles or processing stops.
Completed commands count once their results are durable, including recorded failure
results; released or cancelled claims do not count. At session start the worker
requests `job.deviceBacklog`, then refreshes it every 45 seconds while processing.
The first successful response freezes the waiting baseline; later responses refresh
only the ETA, so newly queued images do not move the baseline. Until the first
response arrives, progress is indeterminate. Progress is completed this session ÷
(completed this session + initial waiting), with zero for an empty denominator.
A restart clears both the completion count and waiting baseline.

The resident worker and iOS background windows both claim with a 60 s lease and renew each
running command every 15 s through `imageProcessing.renew`; the executor's deadline moves with each renewal, and a refusal
(`lease_lost`, `job_obsolete`) stops that command without recording or releasing it. Every claim
the device stops working on before recording a result is released best-effort (bounded at 3 s):
stop, sign-out, quit (macOS settles a pull in flight, bounded at 3 s, then waits for the
releases), iOS backgrounding outside a granted system window, participation off, macOS
system sleep, a remote pause, and a command this build cannot parse — after which the drain backs
off before pulling again. macOS reports `foreground` from the scene state, keeps working while
locked or in the background, stops pulling during system sleep, and pulls immediately on wake and
on every reconnect. A result whose delivery fails is set aside on disk with its own capped backoff
(2 s doubling to 15 min), shared by the resident worker and the charging window. Replay sends never-attempted results first,
then the least recently attempted, in an order stored beside the outbox so it survives relaunch, so
rejected results cannot starve a bounded window; deliveries and
pulls continue and Activity shows "N results waiting to deliver" with the latest error. A subscription counts as open when the doorbell's greeting ring arrives, within 15 s; one that never greets is closed and retried with backoff. While reconnecting, Activity shows a spinner, the failed attempt number, a live countdown to the next try, and the error with the step that failed (sign-in, open, ping, receive); the first failure of a streak and every tenth also reach diagnostics, even when the reconnect loop treats it as expected. A 426
CLIENT_UPDATE_REQUIRED from any image operation, including a charging window's pull, renewal,
delivery or claim release, cancels execution, keeps recorded results, ends background windows, stops pulling for the
worker's life, latches the app's update banner (the worker's client shares the app's request
observer), and Activity shows "Update required to process images". Activity's "This device" row
always names the worker phase (idle, connected, pulling, processing N, update required, paused
from the web, automatic work off, asleep, disconnected with the last error). While image work
waits for a device, a banner at the top reads `job.deviceBacklog` ("N images waiting for an Apple
device · M working · about X at the current pace", the pace omitted without a server ETA) and, when
no device claimed work recently and this one is not processing, says to keep Cubby open on a Mac.
Processing image jobs are the generic imageJob rows of the `processing` saved view (live leases),
each with its IPR code, its Run and a live lease countdown from `leaseExpiresAt`. Rows whose
`leaseDeviceId` is this install's Device (matched by `installationId`, never by name) sit under
the worker row; the rest group by Device under "Other devices", followed by one counted row per
executor holding expired leases (the `job.queue` `leases` summary). Activity reloads every 15 s
while on screen. The household queue reads `job.queue` (a failed refresh keeps the earlier counts
beside an inline error): Apple-device and cloud-AI counts by waiting-on reason (funding waits with
their reopening time), "Waiting for Apple · N" opening the imageJob `waiting-for-apple` view, and
Jobs backing off; Runs needing attention (the manifest's `attention` saved view, which excludes
system AI passes) carry their `job.runRollups` counts, stall flag and expired leases awaiting
reclaim.

On iOS 26+, **Process queue now** in Activity and Settings › Image work submits
an immediate `BGContinuedProcessingTaskRequest`. The companion drains inside the
system-granted window after locking the screen or backgrounding, reports its
same session completion count and progress denominator to the system progress UI, and releases
unrecorded claims before completing after expiration or system cancellation.
A separate `BGProcessingTaskRequest` (`com.nickysemenza.cubby.image-queue`)
requires external power and network connectivity for opportunistic overnight
work. Both windows use the shared slot setting, renew every 15 s, and retain
undelivered results in the same outbox. A foreground subscription settles and
releases its claims before a system window starts, then resumes when the
window ends if the app is active. Library sync retains its concurrent companion pass, so that window still processes
image work alongside photo matching and metadata sync. Overlapping windows use the
same worker; expiration cancels only the pass owned by that window.
The OS chooses charging-window timing; a physical iPhone must verify continued
processing, system cancellation and overnight scheduling without a debugger.
Identifiers/background modes come from `project.yml`; iOS background GPU access
is declared in the app entitlement and requested only on supported devices.
macOS keeps its existing awake/background behavior.

The worker subscribes to the `imageProcessing.work` doorbell (`/api/doorbell`). The ring carries
no job: on subscribe, on every ring and after each result the worker drains, calling
`imageProcessing.pull` with its hello and free-slot count until nothing is claimable or every slot is busy, and
delivering each result through `imageProcessing.complete`. A missed ring costs latency, not
work, because `pull` also claims `waiting_for_device` jobs. `--once` therefore drains a backlog
before it goes idle. A job that
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

## On-device Identify

Identify indexes Product covers by record ID before ranking: repeated records
share one feature print and one result slot, and the indexed count is the number
of unique Products. Photo and rebuild controls wait for indexing to finish.
Progress updates complete before the ready state; a retained photo is ranked
again after the index finishes or is rebuilt, so partial results are not final.

## Verification

- `pnpm apple check` runs native formatting, prepares FFI, then runs CubbyKit
  host tests and iOS simulator compilation sequentially. Use `host`, `app`, or
  `lint` for one scope. [CI](../../docs/ci.md) owns cache behavior.
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

Enable **Background GPU Access** on `com.nickysemenza.cubby` for the continued-processing GPU entitlement; capability changes invalidate App Store profiles, so regenerate (Edit → Save) both `AppStore com.nickysemenza.cubby iOS` and `AppStore com.nickysemenza.cubby macOS` afterwards.

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

Launching under LLDB indexes the generated client and shows a 10-30s white screen on
device. Use the `Cubby-iOS-NoDebugger` / `Cubby-macOS-NoDebugger` schemes for fast UI iteration
when you don't need breakpoints. When you do need the debugger, copy
`apps/apple/lldbinit-Xcode.example` to `~/.lldbinit-Xcode` first — it enables LLDB's on-demand
symbol loading, which cuts attach time on the regular schemes.
