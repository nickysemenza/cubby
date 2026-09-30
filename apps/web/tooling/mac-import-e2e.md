# Actual Mac import convergence

Run from this checkout on an unlocked Mac:

```sh
pnpm --dir apps/web exec tsx tooling/mac-import-e2e.ts
```

The runner builds the real `Cubby-macOS` Debug app, stages it at `~/Library/Caches/CubbyMacImportFixture/Cubby.app`, signs it with an available Developer ID Application identity from the project team and sandbox/file/network/browser entitlements, and registers that exact path before launch against a disposable local Worker, object-storage service and `cubby_sim_*` database. A synthetic member signs in through the normal auth endpoints. The installed `agent-device` native macOS helper activates the verified running fixture PID, selects the synthetic Monarch CSV through the native file picker, reviews the charge, approves it, and verifies the Saved screen. SQL readback asserts two source rows and one transaction after the UI action.

The driver uses native AX snapshots and finite CGEvent coordinates against the exact bundle and launched PID. AppKit activates the verified PID directly without sending the app an AppleEvent. It never asks XCTest to open or relaunch the app. Each action retains its observed state; launch evidence verifies the same process and fixture arguments before and after adapter binding. System Events types only into the owned native file picker, after the native helper confirms foreground ownership. Screenshots capture only that process’s window. The manifest includes the helper binary SHA-256.

The stable fixture bundle `com.nickysemenza.cubby.e2e` has a distinct identity and path from the installed app. Strict DEBUG loopback configuration resets the fixture’s preferences and uses fresh in-memory auth and installation identity each process; it does not contact the login Keychain for auth or installation IDs. Every attempt retains a fresh nonce database, auth session, helper session and browser profile. The fixture removes associated-domain entitlements. A host-wide atomic lease rejects concurrent attempts before staging, and a process check refuses to replace an already-running fixture.

The runner queries `security find-identity` and matches Developer ID Application certificates to `apps/apple/project.yml`’s development team. If none or several match, it fails before signing or launch. `CUBBY_E2E_SIGNING_IDENTITY` can select an available matching certificate by its local selector; no certificate names, identity hashes or private keys belong in repository files or artifacts. There is no ad-hoc fallback and no automated change to macOS permissions or security settings.

[Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) recommends Apple-issued signatures for reliable macOS local-network identity tracking and warns that the main executable’s UUID must be present and unique. The canonical fixture builds with `ENABLE_DEBUG_DYLIB=NO`, preserving linker-generated UUIDs. Signature evidence records the public team, certificate type, designated-requirement digest, executable UUIDs and full signed bundle hash. A stable identity may require an initial normal macOS approval; repeated unattended behavior must be verified on the host rather than inferred from signing alone. Ctrl-C cleans up the owned helper, local services and disposable database; a database watchdog also handles abrupt runner exit.

Each attempt writes `artifacts/mac-import-e2e/cubby_sim_*/run-manifest.json`, `SHA256SUMS`, action output, and any verified fixture screenshots/readback. The manifest records the revision, replay command, runtime versions, app binary fingerprint and source/build provenance. Dirty source is marked non-replayable. Failed attempts remain failed even if the app launched.

For repeated driver diagnostics, `CUBBY_E2E_REUSE_NATIVE_MANIFEST` may name a prior sealed manifest whose native build matched its source. Reuse requires a version-2 input fingerprint and the cached whole-app bundle fingerprint to match that manifest. Inputs include all native sources/resources, generated OpenAPI/config/entity-manifest data, package manifests/pins, Xcode project settings, staged FFI binaries and the complete resolved Rust source graph. The app fingerprint covers debug dylibs, frameworks and resources as well as the main executable. Legacy fingerprints require a fresh build. The fixture retains its stable signed bundle when the unsigned input hash, identity configuration, entitlements and whole signed bundle hash still match; `codesign` verifies its team, bundle and designated requirement before reuse. Changed inputs replace that fixture bundle under the host lease, while the unsigned build cache remains intact. Normal replay builds the app. Web build verification remains required in both modes.

`CUBBY_E2E_DIAGNOSTIC_HOLD=1` keeps an app whose exact fixture process and launch arguments have been verified and its local services alive for at most three minutes after failure. The failed artifact records the exact owned bundle, staged app path, launch PID and helper session in `diagnostic-state.json`; create `diagnostic-release` in that attempt's artifact directory to trigger cleanup early. Interrupts also end the hold. Default runs clean up immediately, and a held failure never becomes a passing result.

If the helper reports `LocalAuthentication Code=-4`, `System authentication is running`, or the frontmost application is `loginwindow`, unlock the Mac and complete the pending system authentication before replaying. Launch success does not establish file import success. Failure screenshots are taken only after the fixture sidebar has been observed.

Append `--browser` to add the actual Mac browser bridge scenario. It stages the bundled Playwright browser at `~/Library/Caches/CubbyMacImportFixture/FixtureBrowser.app` under the stable `com.cubby.fixture.browser` identity, signed with the same project team and a dedicated nonce profile, serves a synthetic retailer over HTTPS, and pins only that generated certificate's SPKI. The sandboxed Cubby fixture permits Apple Events only to that fixture browser identity; DEBUG launch configuration targets it and keeps the HTTPS allowlist guard intact. Production browser identifiers and entitlements remain unchanged.

The browser scenario seeds only synthetic member/vendor/account/run prerequisites through production writers. Commands cross the actual Workerd broker and the signed-in native app's WebSocket. A signed-out capture must pause authentication. Native Settings opens the fixture browser, a UI click signs into the synthetic retailer, and native Sync now must resume the same Run. A subsequent native capture recovers its dedicated window and observes order-001 and the exact black size-M shirt.

Fixture infrastructure can be checked independently without launching an app:

```sh
pnpm --dir apps/web exec tsx tooling/mac-retailer-preflight.ts
```

That preflight verifies the stable Developer ID signed browser bundle and HTTPS certificate/authentication page. Its artifact explicitly records that native capture was not run.

The fixture Chromium process uses `--use-mock-keychain` and disables DialMediaRouteProvider, following [Chromium’s macOS developer instructions](https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md#avoiding-system-permissions-dialogs-after-each-build). These flags avoid requesting the real login Keychain and media-discovery network consent for the disposable fixture profile. The fixture metadata records these choices.

Use `--order csv,photo,receipt` to compose native CSV intake and booking, two-photo upload and review, and retailer capture and receipt review in a specified order. Only external image-description, grouping and receipt-extraction outputs are supplied deterministically. Original upload hashes, captured receipt facts, pre-approval economic records and canonical final graph links are checked independently; production writers perform the economic changes.

Run all six orders sequentially with:

```sh
pnpm --dir apps/web exec tsx tooling/mac-import-orders-e2e.ts
```

Every child owns a fresh database, fixture runtime state and browser profile under the shared stable signed identity. Later children may reuse the verified native build; source and whole-bundle fingerprints are still checked by the child runner. The batch stops after its first failure, leaving later orders unrun, so a system dialog does not trigger repeated launches. Its sealed aggregate copies only checksum-verified evidence declared by each child manifest, excluding browser profiles, certificates and app bundles. An authored scenario does not establish actual Mac acceptance; all six must finish successfully on an unlocked host.
