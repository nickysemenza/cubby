# Actual Mac statement import

Run from this checkout on an unlocked Mac:

```sh
pnpm --dir apps/web exec tsx tooling/mac-import-e2e.ts
```

The runner builds the real `Cubby-macOS` Debug app, stages it at a unique artifact path, signs it with sandbox/file/network/browser entitlements and a unique fixture bundle identifier, and registers that exact path before launch against a disposable local Worker, object-storage service and `cubby_sim_*` database. A synthetic member signs in through the normal auth endpoints. The installed `agent-device` native macOS helper activates the verified running fixture PID, selects the synthetic Monarch CSV through the native file picker, reviews the charge, approves it, and verifies the Saved screen. SQL readback asserts two source rows and one transaction after the UI action.

The driver uses native AX snapshots and finite CGEvent coordinates against the exact bundle and launched PID. It never asks XCTest to open or relaunch the app. Each action retains its observed state; launch evidence verifies the same process and fixture arguments before and after adapter binding. System Events types only into the owned native file picker, after the native helper confirms foreground ownership. Screenshots capture only that process’s window. The manifest includes the helper binary SHA-256.

The unique bundle identifier isolates preferences and sandboxed auth files. Only associated-domain entitlements are omitted from the ad-hoc fixture build. The installed app and production configuration are unchanged. Ctrl-C cleans up the owned helper, local services and disposable database; a database watchdog also handles abrupt runner exit.

Each attempt writes `artifacts/mac-import-e2e/cubby_sim_*/run-manifest.json`, `SHA256SUMS`, action output, and any verified fixture screenshots/readback. The manifest records the revision, replay command, runtime versions, app binary fingerprint and source/build provenance. Dirty source is marked non-replayable. Failed attempts remain failed even if the app launched.

For repeated driver diagnostics, `CUBBY_E2E_REUSE_NATIVE_MANIFEST` may name a prior sealed manifest whose native build matched its source. Reuse requires a version-2 input fingerprint and the cached whole-app bundle fingerprint to match that manifest. Inputs include all native sources/resources, generated OpenAPI/config/entity-manifest data, package manifests/pins, Xcode project settings, staged FFI binaries and the complete resolved Rust source graph. The app fingerprint covers debug dylibs, frameworks and resources as well as the main executable. Legacy fingerprints require a fresh build. Every attempt clones the verified app before assigning its new fixture identity and entitlements, retaining isolated preferences and leaving the cached build intact. Normal replay builds the app. Web build verification remains required in both modes.

`CUBBY_E2E_DIAGNOSTIC_HOLD=1` keeps an observed fixture app and its local services alive for at most three minutes after failure. The failed artifact records the exact owned bundle and helper session in `diagnostic-state.json`; create `diagnostic-release` in that attempt's artifact directory to trigger cleanup early. Interrupts also end the hold. Default runs clean up immediately, and a held failure never becomes a passing result.

If the helper reports `LocalAuthentication Code=-4`, `System authentication is running`, or the frontmost application is `loginwindow`, unlock the Mac and complete the pending system authentication before replaying. Launch success does not establish file import success. Failure screenshots are taken only after the fixture sidebar has been observed.

Append `--browser` to add the actual Mac browser bridge scenario. It clones the bundled Playwright browser into a uniquely identified fixture app with a dedicated profile, serves a synthetic retailer over HTTPS, and pins only that generated certificate's SPKI. The sandboxed Cubby fixture permits Apple Events only to that unique browser identity; DEBUG launch configuration targets it and keeps the HTTPS allowlist guard intact. Production browser identifiers and entitlements remain unchanged.

The browser scenario seeds only synthetic member/vendor/account/run prerequisites through production writers. Commands cross the actual Workerd broker and the signed-in native app's WebSocket. A signed-out capture must pause authentication. Native Settings opens the fixture browser, a UI click signs into the synthetic retailer, and native Sync now must resume the same Run. A subsequent native capture recovers its dedicated window and observes order-001 and the exact black size-M shirt.

Fixture infrastructure can be checked independently without launching an app:

```sh
pnpm --dir apps/web exec tsx tooling/mac-retailer-preflight.ts
```

That preflight verifies the unique signed browser bundle and HTTPS certificate/authentication page. Its artifact explicitly records that native capture was not run.

`MacImportDriver` also exposes photo upload into a new import run and photo approval helpers for composed journeys. These helpers require unlocked-host verification. CSV/photo/receipt ordering permutations are not exercised by this runner.
