# apps/apple agent rules

Native app: SwiftUI (iOS 26 / macOS 26) + `CubbyKit` package + `cubby` CLI
harness. This document is the current native implementation guidance.

For fast iteration, choose the loop in [ITERATION.md](ITERATION.md): focused
Swift tests or previews for failures native E2E cannot observe,
`test:e2e:headless:watch` for API behavior, and
`dev:sim:watch` for repeated simulator UI interactions. The warm simulator
runner owns its disposable database and agent-device session; stop it with
Ctrl-C when done. Run `test:e2e:sim` for the full Search journey.

## Build order

`node scripts/ensure-apple-ffi.ts` (Nx-cached `build-rust.sh`; restores the xcframework + shim
across worktrees when Rust is unchanged) → `pnpm generate` (the gitignored generated Swift and the
CubbyAPI plugin's OpenAPI inputs) → `xcodegen generate --spec apps/apple/project.yml --use-cache`. If a build fails with the literal text
`artifact of binary target 'CubbyFFIBinary' not found`, the xcframework is missing — run
`ensure-apple-ffi.ts` first.

## Wire rules (non-negotiable)

- `/api/v1` has no `{ok,data}` envelope: a 2xx body _is_ the payload. Every error status carries
  one bare `ApiError` body (`{code, message, reason?, requestId?, validationIssues?}`), decoded by
  `CubbyAPIError` — never a per-operation error type.
- A flat list/get query is plain GET query params: `page=1&pageSize=20&sort=-name`, literal values
  (never JSON-quoted), and an array repeats its key (`tagFilters=a&tagFilters=b`), never a
  JSON-encoded array value. A structured query (search, a filter tree, anything nested) is a POST
  body instead — never hand-build a query string for one.
- Send `Origin: cubby-mobile://` on every `/api/auth/*` request (Better Auth trusts this origin;
  omitting it fails sign-in).
- Store the `set-auth-token` response header verbatim in Keychain. If a _later_ `/api/auth/*`
  response carries a different `set-auth-token`, overwrite the stored value — do not keep the
  first one.
- Hand-written Swift names generated types only through the aliases in
  `CubbyKit/Sources/CubbyKit/Generated/APITypes.swift` (`Product`, `ProductListItem`,
  `PlantingOut`, `ScanAtLocationOut`, …), never as `Components.Schemas.*`, and never a
  anonymous `…Payload`/`InputShared…`/`OutputShared…` name — structural names can
  change when a schema changes (reach an anonymous value by property and let
  inference carry the type). The generator's output is its own SPM
  target, `CubbyAPI` (`CubbyKit/Sources/CubbyAPI/`), so editing hand-written CubbyKit code
  does not recompile ~58k generated lines; `import CubbyAPI` appears only inside CubbyKit
  (`API/*.swift`, `Generated/*.swift`, and the model files that extend a generated type), never
  in the App or the CLI. There is no hand-written mapping layer: a screen reads the generated
  type, and the few derived values it needs (`stableKey`, `manufacturerOrNil`, `MacroSummary`,
  …) live as extensions in `API/GeneratedTypeExtensions.swift`. A wire type the generator gets
  wrong is fixed in the generator (`scripts/generator/http-api/`), not re-typed by hand. The
  branded codes (`ProductCode`, `LocationCode`, `InventoryEntryCode`, `ImageCode`), `PlainDate`,
  and `EntityKey` live in `CubbyKit/Sources/CubbyAPISupport/` and are the generated client's own
  types for those schemas (`typeOverrides` in `Sources/CubbyAPI/openapi-generator-config.yaml`).
- Response bodies are open: the OpenAPI emitter strips `additionalProperties: false` from
  every output schema (`scripts/generator/http-api/openapi.ts`, guarded by
  `openapi-document.unit.test.ts`), so the generated `init(from:)` ignores a field it does
  not know and an installed build survives a server deploy that adds one. Request bodies
  stay closed. Never hand-add `additionalProperties: false` to an output, and never rely on
  the client to reject an unknown response key.
- Always pass `serverURL` explicitly when constructing a generated `Client`. The spec's `servers`
  entry is `"/"`, which is not a usable absolute URL on its own.

- Never hand-write a `(method, path)` pair. `OperationRoute.all` is generated from the OpenAPI
  document by `scripts/generator/http-api/native.ts` into `Generated/OperationRoutes.swift`
  (`pnpm generate`). Look routes up
  by operation id; entity reads go through `CubbyClient.list`/`row`, never a path. Every
  `resources.<entity>.{list,get,create,update,timeline}` operation the OpenAPI document exposes is
  generated (not every entity has every verb: `image` has only `update`/`delete`; `cookbook` and
  `usda-food` have no resource verbs, per `Generated/EntityOperations.swift`'s `httpActions`;
  `delete` stays off the client). The RPC operation ids CubbyKit calls are flagged
  `native: "<why>"` on their contract member (`apps/web/src/contracts/*.contract.ts`) — flagging
  an automatic resource id is rejected.
  `Sources/CubbyAPI/openapi-generator-config.yaml` and `Generated/EntityOperations.swift` are
  emitter-owned, derived from those flags — edit the flags, never the two files. Any
  swift-openapi-generator warning (a silently dropped schema) fails
  `apps/apple/scripts/check-openapi-warnings.sh`, which CI's `Apple package tests` job and
  `pnpm apple check` run; the build plugin alone would let it through.
- `App/<platform>/Info.plist` is generated by XcodeGen from `project.yml` `info.properties`;
  edit the YAML, never the plist (a regenerate silently reverts hand edits, including URL schemes).
- Presigned image PUTs (`PresignedUpload`) send only `Content-Type` and no auth header; every
  other request goes through `CubbyAuthMiddleware`.
- An error that reaches the UI also goes through `Diagnostics.report(error, context:)` (one line
  beside the existing string assignment; skip catches that already funnel into
  `AppModel.handle`, which reports once). Sentry is an app-target dependency only — CubbyKit
  never imports it.

## Language and style

- Swift 6 strict concurrency (`swiftLanguageModes: [.v6]`). No unchecked `Sendable` escapes without
  a comment explaining why.
- Observation (`@Observable`), not Combine, for view state.
- Swift Testing (`import Testing`, `@Test`, `#expect`) for all tests. Never XCTest. Suites run in
  parallel: a `URLProtocol` stub with a static handler must be per-suite (`.serialized` only
  orders tests inside one suite) — Swift disallows a stored `static` on a generic type, so this
  cannot be a single shared `StubURLProtocol<Tag>`. `Tests/CubbyKitTests/Support/StubURLProtocol.swift`
  holds the shared plumbing (`StubNetworking`); each suite that stubs the network declares its own
  tiny concrete subclass with its own `static let handler`, per that file's doc comment.
- App Intents: `perform()` is not `@MainActor` in the SDK and entities/queries are `Sendable`.
  Entity and query types are declared `nonisolated`; intent structs keep the MainActor default
  (their `@Parameter` stored properties cannot be nonisolated) and mark sync statics such as
  `parameterSummary` `nonisolated`. App Shortcut phrases may only embed AppEntity/AppEnum
  parameters, never strings.
- Every SwiftUI view gets a `#Preview`, fed by `PreviewFixtures` where practical; API-typed
  fixtures are generated (see Generated files).
- Screen density (inline titles, system spacing, toolbar-placed actions, hero sizing): see
  `apps/apple/DESIGN.md` § Density.
- `#Playground` blocks (`import Playgrounds`) only under `#if DEBUG`. They are exploration
  aids for Xcode, not a verification tier.

## Generated files (read-only)

- `CubbyKit/Sources/CubbyKit/Generated/entity-manifest.json` and
  `CubbyKit/Sources/CubbyAPISupport/Generated/EntityKey.swift` — from
  `scripts/generator/entities/render/swift-catalog.ts`. Regenerate with `pnpm generate`
  (repo root). The manifest is a CubbyKit resource (`Package.swift`) that `EntityCatalog`
  decodes once into the hand-written `Codable` types in `Catalog/EntityManifest.swift`
  (synthesized encoding: `{"case":{"_0":…}}` for an unlabelled payload). Those types'
  `String` enums (renderer, slot, hero-action, field/filter/control kinds, …) are hand-written
  and `pnpm generate` fails until their cases match the TS vocabulary exactly — add the case
  it names. `EntityManifestTests` decodes the bundled manifest so a mismatch fails CI.
- `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift` — from `uniffi-bindgen`. Regenerate with
  `node scripts/ensure-apple-ffi.ts` (or `apps/apple/scripts/build-rust.sh` directly).
- The `CubbyAPI` target — swift-openapi-generator's typed client and schema types, generated at
  build time by its SwiftPM plugin from `Sources/CubbyAPI/openapi.json` (a copy of
  `apps/web/src/lib/generated/http-openapi.gen.json`) and `openapi-generator-config.yaml`, both
  written by `pnpm generate`.
- `CubbyKit/Sources/CubbyKit/Generated/{OperationRoutes,EntityOperations,ClientOperations,APITypes}.swift` —
  the runtime route table (`OperationRoute.all`), the per-entity `list`/`timeline`/`get`/`create`/
  `update`/image-attach switches with `EntityKey.httpActions`/`nativeActions` and the generated
  filter arms (one per list/timeline query parameter, from
  `scripts/generator/http-api/swift-operations.ts`; a parameter schema shape outside its table
  fails generation), the `CubbyClient` methods that are exactly one call with the JSON body as
  their only argument (`CLIENT_PASSTHROUGH_METHODS` in the same file — a new such method is a
  table entry, not hand-written Swift; anything that maps or branches stays in
  `API/CubbyClient.swift`), and the public aliases for every generated type the native client carries,
  from `scripts/generator/http-api/native.ts` reading the `native` flags on contracts. Regenerate
  with `pnpm generate`. That same script also writes `Sources/CubbyAPI/openapi-generator-config.yaml`
  from those flags.
- `App/Shared/Previews/Fixtures/*.json` — wire JSON for `PreviewFixtures`' API-typed fixtures
  (`PreviewFixtures.fixture(_:)`), built from the zod schemas by
  `apps/web/scripts/apple-preview-fixtures.ts`. To change what a preview shows, edit that
  script's overrides and run `pnpm generate`.

None of these is committed; edit the generator or its inputs, never the output. A missing one
means `pnpm generate` (or `build-rust.sh`) has not run in this checkout.

## Verification

- `pnpm apple <cli|mac|ios|sim|gen|test>` from the repo root launches each product (README "Running").
- `swift build --package-path apps/apple/CubbyKit`
- `swift test --package-path apps/apple/CubbyKit`
- `xcodegen generate --spec apps/apple/project.yml` (when `project.yml` changes)
- Full app build needs the xcframework from `ensure-apple-ffi.ts` first.
- `swift format lint --strict --configuration apps/apple/.swift-format --recursive` (see
  `scripts/apple-check.sh`, the `apple` Nx target on `apps/apple/project.json`) gates
  formatting; run
  `swift format --in-place --configuration apps/apple/.swift-format --recursive` to fix.
  `pnpm verify:local(:full)` runs the `apple` target locally when a full native
  diagnostic is needed. GitHub Actions runs `pnpm apple check` on macOS for
  every PR and `main` push.
- **Visual and interaction checks:** the Xcode MCP renders `#Preview`s headlessly and drives a
  simulator (tap, swipe, type, capture) — setup, loops, and failure fixes in
  [docs/agents/xcode-mcp.md](../../docs/agents/xcode-mcp.md). Preferred over launching the app
  to look at one screen.

### Universal links

The AASA lives at `https://cubby.nickysemenza.com/.well-known/apple-app-site-association`
(served by apps/web). Apple's CDN caches it (up to ~24h) and the app fetches it at install —
reinstall the app to refetch after a change. For a dev device, add
`applinks:cubby.nickysemenza.com?mode=developer` to the entitlement and enable Developer Mode.
Test on the simulator with `xcrun simctl openurl booted https://cubby.nickysemenza.com/LOC-XXXX`.

### Traps that cost real time (fixed; do not rediscover)

- macOS sandbox entitlements on the iOS target make `simctl launch` hang on a black screen with
  no error and no process — targets keep per-platform entitlements files.
- `build-rust.sh --targets sim` writes a ONE-slice xcframework; a macOS build or CLI link then
  fails "no library for this platform". Run `--targets all` first. Never run two cargo commands
  against the shared `CARGO_TARGET_DIR` at once.
- The CLI's ad-hoc signature changes every rebuild, so Keychain re-prompts; it uses a file token
  store under Application Support instead. `URL.path()` percent-encodes — use
  `path(percentEncoded: false)` for FileManager.
- The API emits `.000Z` timestamps the generated client rejects; use `Configuration.cubby`
  (`LenientISO8601DateTranscoder`). Product list rows carry no image URLs (`coverImageUrl` is on
  detail only); image `status` is `PENDING|UPLOADED|FAILED`.
- A generator must never emit one giant array literal: a ~900-line `EntityCatalog.all` literal
  made Release/WMO spend ~650 s single-threaded in the SIL `COWArrayOpt` pass. Per-entity
  `private static let` descriptors listed in `all` cut it to 13 s; the catalog is now bundled
  JSON decoded at runtime, so it costs the compiler nothing. To find such a stall again:
  `sample <swift-frontend pid>` shows the pass; `-Xllvm -sil-print-pass-name` is buffered, so
  stream it through `script` under an `alarm` and demangle the last `Function:` line.
  `xcodebuild archive` is not incremental — compare with `xcodebuild build -configuration Release`
  and a `-derivedDataPath`.
- `Cubby.xcodeproj` is generated and gitignored; the checkout hook regenerates it, but a rebase
  runs that hook before replaying your commits, so Swift files they add are missing from the
  project ("Cannot find … in scope"). Run `pnpm apple gen`.
- Running `knip --cache` before `packages/wasm` exists poisons `node_modules/.cache/knip`
  ("Unresolved imports …recipebridge_bg.js" on every later pre-commit); `rm -rf` that cache.
- Symptom: a re-presented `.sheet(item:)` shows the previous item's state even though the item's
  `id` changed. Rule: state lifetime follows the data's identity — own the model in the presenter
  (build it alongside the item) or resync with `.task(id:)`; never seed `@State`/`@StateObject`
  from an init parameter. Gated by `apple-check.sh`'s `State(initialValue:`/
  `StateObject(wrappedValue:` grep (tag a deliberate exception `// state-init-ok: <reason>`).

### Debugging on device

Launching under LLDB indexes CubbyKit's ~60k generated lines and shows a 10-30s white screen on
device. Use the `Cubby-iOS-NoDebugger` / `Cubby-macOS-NoDebugger` schemes for fast UI iteration;
for the regular debugger schemes, copy `apps/apple/lldbinit-Xcode.example` to
`~/.lldbinit-Xcode` to enable LLDB on-demand symbol loading.

Do not run root `pnpm` scripts from here — `apps/apple/**` and `cubby-ffi/**` are excluded from
oxfmt/oxlint (Swift is covered by its own `swift-format` gate above, not oxfmt/oxlint), and
running root pnpm scripts early can rewrite Swift-adjacent JSON fixtures.
