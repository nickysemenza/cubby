# Nightly TestFlight publishing

Status: approved implementation brief; implementation and PR validation in progress.

## Outcome and decisions

Normal merges to main make code eligible for the next nightly release. They
do not start a TestFlight build. Keep GitHub Actions, the existing generated
Xcode project, standard Apple signing actions, and native xcodebuild.

- Nightly: inspect current main and publish when native inputs changed since
  the last complete upload, or the last complete upload is at least 30 days
  old. Proposed schedule: 10:17 UTC daily, away from the top of the hour.
- Manual: Run workflow publishes current main even when unchanged.
- Breaking change: changing the dedicated compatibility-version declaration
  on main queues a release promptly. The planner compares version values;
  comment-only edits do not cause an immediate release.
- Versioning: one manually edited compatibility version supplies both the
  app marketing version and server minimum. Each upload gets a CI build
  number. Compatible changes do not bump the compatibility version.
- Server deployment: retain immediate deployment and accept the temporary
  update-required period until a replacement app is available and installed.
  The user explicitly selected this policy.
- Long inactivity: manually re-enable scheduling and dispatch a fresh build
  if GitHub disables the workflow. The user explicitly selected this policy.
  Keep scheduling inside GitHub Actions.

Use one implementation PR. The implementation agent owns code and workflow
edits; the main agent owns documentation, live metadata checks, integration,
and final validation. Hosted Linux and macOS runners own release execution.
Before merge, obtain independent gpt-6.1-sol/high and gpt-6-astra/high reviews
for the release workflow changes.

## Existing evidence

The current workflow publishes only v-prefixed tags, takes marketing version
from the tag, and assigns commit-count/run-attempt build coordinates.
Two macOS archive jobs hand archives to a third macOS export/upload job.
That third job repeats signing imports and profile downloads. Main CI
separately warms distribution FFI caches.

The HTTP gate compares the version in the existing app User-Agent to a
server-owned minimum. It does not use the bundle build number. Native
ClientIdentity already reads CFBundleShortVersionString. Keep that wire
shape; no new compatibility header or parallel protocol-version scheme is
needed.

The existing generator fingerprints packages and generator sources and
records every emitted file for missing-output detection. The shared Apple
generated-input artifact must include any new build-settings output.

Owning paths:

- .github/workflows/apple-testflight.yaml
- .github/workflows/ci.yaml and .github/ci-paths.yaml
- apps/apple/scripts/testflight.sh and apps/apple/project.yml
- apps/web/src/server/apple-client-gate.ts and its focused test
- scripts/generator/entities/render/swift-shared-constants.ts
- .github/actions/generate-apple-inputs/action.yml
- docs/ci.md, apps/apple/README.md, and Apple/root agent rules

## 1. Establish safe migration coordinates

GitHub's last successful two-platform upload used marketing version 2.4.1
and build 2815.1. The latest successful server deployment accepts version
2.13. Initialize the shared value to 2.13.0 to preserve that compatibility
floor, and use a fixed build-number offset of 10000 above the evidenced
upload. The marketing version changes to reflect the actual compatibility
floor; there is no added wire break.

Live App Store Connect verification confirms both latest listed builds are
2.4.1 (2815.1), Internal and Testing. The internal group uses Automatic for
Xcode Builds distribution. Verify the replacement builds process and install
after the first real upload.
Keep private App Store metadata out of the plan, fixtures, logs, and PR text.
No existing data migration is needed.

## 2. Single compatibility declaration

Add packages/shared/src/apple-client-version.ts with one exported,
three-component APPLE_CLIENT_COMPATIBILITY_VERSION. Keep this declaration
in its own file so its push trigger means a compatibility-policy edit.

The server imports that value as its minimum. Extend the existing generator
to emit apps/apple/Generated/AppleVersion.xcconfig containing MARKETING_VERSION.
Reference it from project.yml for both configurations and all app/extension
targets; remove the hand-written marketing-version literal. Keep a local
build-number default, never manually bumped for uploads. CI overrides only
CURRENT_PROJECT_VERSION.

Add the generated directory to .gitignore and the generated-input artifact.
Use the existing generator's output tracking and invalidation, rather than
a new version-generation command. ClientIdentity continues reading the bundle
marketing version, and Sentry continues identifying version plus build.

Completion: a clean generation and XcodeGen run produces the shared version
for iOS, macOS, and the embedded extension; the server imports the same
declaration. Preserve the regression that a freshly produced app satisfies
the HTTP minimum. Replace the project.yml literal-reading assertion only
after verifying the generated setting at the actual Xcode boundary.

## 3. One small release decision step

Keep the existing workflow filename. Replace tag coordinates with a Linux
planning job. Use Node 24, already the repository toolchain, and the GitHub
API/CLI. Limit custom policy logic to a small scripts/apple-release.ts;
reuse the existing full/apple path classification from .github/ci-paths.yaml.
Extend it for generator inputs that can change the native catalog or client,
without duplicating a separate release-only list.

The planner resolves current main once and passes that exact SHA, version,
build number, and release reason to every subsequent job. Scheduled or
queued runs use current main when they start. Publishing from another
workflow ref is refused before credentials or macOS jobs are used.

Release reasons: native changes, compatibility bump, manual request,
30-day refresh, or missing upload checkpoint. If none applies, exit
successfully before generation, signing, or macOS allocation. Distinguish
missing/expired history from an API permission or network error: the former
causes a rebuild, the latter fails with diagnostics.

Add a main push trigger restricted to the compatibility declaration. Ordinary
main pushes do not trigger this workflow. Add a nightly schedule and manual
dispatch. A manual publish is always forced; it has no version/tag inputs.
The planning script itself performs read-only inspection and prints its
decision, so it can be exercised locally without a separate workflow mode.

Permissions remain contents:read plus actions:read for reading prior upload
evidence. Retain one publishing concurrency group with cancel-in-progress:false
and the single pending slot.

## 4. Upload checkpoint and build numbering

After BOTH platform jobs successfully return from export/upload, a small
Linux finalization job writes an apple-testflight-uploaded artifact containing
the resolved SHA, compatibility version, build number, and upload timestamp.
Retain it for 90 days, subject to repository limits. Only these authenticated
workflow artifacts count as prior uploads. Paginate artifact lookup; do not
depend on the latest successful run, because nightly skips also succeed.

Compare the checkpoint's SHA to target main, not merely the previous main
commit. This includes native changes accumulated across intervening web/docs
merges. Missing, expired, or unavailable baseline commits cause a rebuild;
malformed evidence fails with diagnostics rather than silently skipping.

Use a fixed migration offset plus the dedicated workflow's run_number as the
build number, shared by both platforms. Reject rerun attempts: retry through
a fresh manual dispatch of current main instead. Because GitHub execution
order is not guaranteed, refuse an older run number if a higher-numbered
main workflow run has already begun or completed, including skips and partial
failures. This conservative rule can discard an older manual request after a
newer no-op; a fresh dispatch is the recovery.
Check this before export as well as during planning. Do not rely on a
changed SHA to establish fresh build coordinates.

If one platform uploads and the other fails, do not advance the complete
upload checkpoint. The next fresh release rebuilds both with a greater
number. This intentionally trades occasional duplicate platform builds
for avoiding separate platform histories. Preserve per-platform failure
diagnostics; the other platform can finish.

The checkpoint means upload acceptance, not TestFlight availability.
Apple processing happens afterward and can fail. Apple sends processing
status notifications; a processing failure uses a fresh manual dispatch
after diagnosis. This PR does not add polling or an App Store release
monitor. The first rollout must verify actual processing and installation.

Completion: unchanged nightly runs never reset freshness;
failed/partial uploads never advance the checkpoint; retries and out-of-order
runs cannot upload an older Mac build number.

## 5. Platform jobs and deletions

Keep shared generated Swift preparation on Linux. Each macOS matrix leg
restores its target-specific distribution FFI/cache, downloads generated
inputs, generates the project, imports signing identities once, downloads
its required profiles once, archives, verifies, exports, and uploads locally.

Simplify testflight.sh to a single platform release invocation. Keep privacy,
signing, dSYM, app-version/build-number, Mac category, installer identity,
and extension metadata checks, including the named historical regressions.
Keep standard signing/profile actions and shared project preparation.
Keep Sentry symbols and failure artifacts. Clean temporary service
credentials on every exit.

Delete:

- tag trigger, tag parsing, tag ancestry and tag/server version comparisons;
- full-history checkout used solely for commit-count numbering;
- the third macOS upload job and archive transfer/download/unpack machinery;
- duplicate signing imports/profile downloads;
- the neither-platform-uploads-alone invariant;
- main CI's separate warm-apple-ffi job;
- stale release ritual comments, including Diagnostics.swift's version-bump
  comment;
- a trivial release-project wrapper only if no caller still benefits from it.

Use existing exact FFI fingerprints and caches in the publishing jobs.
Removing the warmer may increase a cold release's elapsed time; measure
naturally occurring runs before claiming a speed improvement.

## 6. Validation and rollout

Before implementation, enumerate plausible failures and write relevant
failing policy tests first. Use the existing Node script-test harness with
synthetic artifacts and disposable Git histories. Cover:

- no-op success does not become a publication baseline;
- changes across several merges are compared to the actual uploaded SHA;
- monthly refresh eligibility, missing history, API failure, and manual force;
- compatibility bump publishes promptly; same-value edits defer to nightly;
- partial failure stays eligible and a fresh attempt receives a higher number;
- stale reruns/out-of-order publishers cannot upload;
- publishing from a non-main workflow ref is refused before signing;
- generator output restored by hosted Apple jobs carries the shared version.

Focused commands: node --test scripts/apple-release.test.ts;
pnpm test:file src/server/apple-client-gate.unit.test.ts;
pnpm generate; XcodeGen plus xcodebuild -showBuildSettings for iOS, macOS,
and the extension; bash -n apps/apple/scripts/testflight.sh.
Use an actual generated-build-settings check instead of a new unit test
that merely compares declarations or mirrors YAML.

Retain required exact-final-head PR CI. Avoid a broad local test rerun for
this release-only change. Hosted native build checks verify compilation;
unsigned or non-upload archive validation should be chosen if needed for
changed Xcode settings. Local planner acceptance exercises the decisions without
uploading. No simulator UI behavior or app API wire format changes are
planned; add a native E2E only if implementation expands into those surfaces.

After review and merge, run one real manual release, verify both builds
process and can be installed through TestFlight, then verify an unchanged
nightly allocates no macOS jobs. Preserve a sanitized acceptance artifact
with revision, replay command, results, and evidence; do not use live
household records or screenshots. The real upload and installation checks are post-merge rollout acceptance;
PR validation does not publish a build.

Update docs/ci.md with the owning release policy, including the explicit
rule that normal merges do not publish. Update apps/apple/README.md,
apps/apple/AGENTS.md, root AGENTS.md, and stale comments in the same PR.
Remove the invalid-smoke-tag procedure and replace it with planner validation.

## Known limits and primary sources

- GitHub scheduled events can be delayed or dropped, and public repositories
  can have scheduling disabled after 60 inactive days. A 30-day heartbeat
  does not guarantee indefinite unattended operation. Manual re-enabling
  is the selected minimal policy.
  [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- Single-pending concurrency coalesces requests, but execution order is not
  guaranteed. Build-number guards are required.
  [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- Mac build numbers must increase across marketing versions.
  [Apple build numbering](https://developer.apple.com/documentation/xcode/setting-the-next-build-number-for-xcode-cloud-builds/)
- Marketing versions use three numeric components.
  [Apple version format](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleshortversionstring)
- Successful upload and completed processing are different states.
  [Apple build status](https://developer.apple.com/help/app-store-connect/manage-builds/view-builds-and-metadata/)
- Xcode Cloud requires a consistently present project; a migration is outside
  this cleanup.
  [Apple Xcode Cloud setup](https://developer.apple.com/documentation/xcode/setting-up-your-project-to-use-xcode-cloud)

Readiness: policy choices are settled and the implementation shape is
established. GitHub upload evidence confirms the last successful two-platform release used
marketing version 2.4.1 and build 2815.1. The current server minimum is 2.13;
the shared declaration starts at 2.13.0. Live App Store Connect confirms the existing builds are Internal and Testing;
replacement build processing and installation remain rollout checks. No production migration, app wire-version transition, or
deployment-topology change is planned.
