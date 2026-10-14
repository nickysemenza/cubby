# apps/apple agent rules

Native app: SwiftUI (deployment floors in `project.yml`) + `CubbyKit` package + `cubby` CLI
harness. This document is the current native implementation guidance.

[ITERATION.md](ITERATION.md) owns focused tests, previews, headless and simulator
loops. [Validation](../../docs/agents/validation.md) owns check selection and delivery.

## Build order

[README](README.md#build-order) owns build order, running, and TestFlight setup.
`artifact of binary target 'CubbyFFIBinary' not found` means the xcframework is missing: run
`pnpm apple gen` (which prepares the native artifacts).

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
  does not recompile the generated client; `import CubbyAPI` appears only inside CubbyKit
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
- The server refuses outdated `cubby-apple` builds with 426 and
  `reason: CLIENT_UPDATE_REQUIRED`; `RequestTrace` latches it and `RootView`
  shows `UpdateRequiredView`. Follow the shared version rule in root AGENTS.md
  and [release policy](../../docs/ci.md#apple-testflight-release).
- The generated client encodes every optional with `encodeIfPresent`, so a typed request body
  cannot carry `null`. A body the app composes as `JSONValue` (editor create/update, hero-action
  and finance operations) goes through `CubbyClient.sending(_:_:)`, which decodes it into the
  typed input and restores its `null`s on the wire (`JSONNullMiddleware`); a required nullable
  key (`sourceId`, `externalAccountId`, a discard `date`) is otherwise rejected as absent. Use
  `.null` only where the input takes `null`; omit a key that is optional but not nullable.
- Always pass `serverURL` explicitly when constructing a generated `Client`. The spec's `servers`
  entry is `"/"`, which is not a usable absolute URL on its own.

- Never hand-write a `(method, path)` pair. `OperationRoute.all` is generated from the OpenAPI
  document by `scripts/generator/http-api/native.ts` into `Generated/OperationRoutes.swift`
  (`pnpm generate`). Look routes up
  by operation id; entity reads go through `CubbyClient.list`/`row`, never a path. Entity reads
  and writes go through the four generic kernel operations (`entity.detail`, `entity.list`,
  `entity.mutate`, `entity.timeline`), dispatched by the hand-written
  `Catalog/EntityKernel.swift` over the generated `Generated/entity-kernel.json` (per-entity
  actions, image attach/reorder, and every list/timeline filter name with its JSON kind). Not
  every entity has every action: read-only `image`, `cookbook` and `run` have no `create`;
  `usda-food`, the external USDA catalog, reads through its flagged `usdaFood.list`/`detail`
  RPCs. Kernel bodies and responses are untyped JSON on the wire; the server parses each with the
  entity's schema, and hand-written Swift decodes a typed record only through the short
  `NATIVE_TYPED_RECORDS` keep-list (`scripts/generator/http-api/type-overrides.ts`).
  `delete` is destructive: only `HeroActionRunner` calls it, after an explicit
  confirmation behind the connection-impact preview. The HTTP API carries exactly the
  operations flagged `native: "<why>"` on their contract member
  (`apps/web/src/contracts/*.contract.ts`).
  `Sources/CubbyAPI/openapi-generator-config.yaml` and `Generated/entity-kernel.json` are
  emitter-owned, derived from those flags and the entity declarations — never edit them. Any
  swift-openapi-generator warning (a silently dropped schema) fails
  `apps/apple/scripts/check-openapi-warnings.sh`, which CI's `Apple host tests` job and
  `pnpm apple check` run; the build plugin alone would let it through.
- `App/<platform>/Info.plist` is generated by XcodeGen from `project.yml` `info.properties`;
  edit the YAML, never the plist (a regenerate silently reverts hand edits, including URL schemes).
- Presigned image PUTs (`PresignedUpload`) send only `Content-Type` and no auth header; every
  other request goes through `CubbyAuthMiddleware`.
- An error that reaches the UI also goes through `Diagnostics.report(error, context:)` (one line
  beside the existing string assignment; skip catches that already funnel into
  `AppModel.handle`, which reports once). Sentry is an app-target dependency only — CubbyKit
  never imports it.

## Hosted pilot boundary

Only Run evidence (transcript, logs, AI usage) is hosted in `RunEvidenceView`.
Keep every native entity detail renderer and coverage test. Run overview, actions,
photo review, and routing remain native. The additive pilot does not bump native
compatibility. Its browser-session POST is the explicit exception to generated
entity operation routes; never send the bearer to WebKit or ambient cookies to
bootstrap. Use a fresh nonpersistent store, exact-origin main-frame bridge checks,
and captured credential revisions across every await. See [DESIGN.md](DESIGN.md#run-evidence-pilot).

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
- Tests never wait on the clock (no `Task.sleep`, deadlines, polling, or yield spins): await
  the work through an internal hook on the model (its `Task`, `idle()`), park a double on the
  shared `Tests/CubbyKitTests/Support/Gate.swift` (also compiled into the app test targets), and
  inject a production pause or expiry where the code itself waits.
- App Intents: `perform()` is not `@MainActor` in the SDK and entities/queries are `Sendable`.
  Entity and query types are declared `nonisolated`; intent structs keep the MainActor default
  (their `@Parameter` stored properties cannot be nonisolated) and mark sync statics such as
  `parameterSummary` `nonisolated`. App Shortcut phrases may only embed AppEntity/AppEnum
  parameters, never strings.
- Every SwiftUI view gets a `#Preview`, fed by `PreviewFixtures` where practical; API-typed
  fixtures are generated (see Generated files).
- Screen density (inline titles, compact token spacing, count style, toolbar-placed actions, hero sizing): see
  `apps/apple/DESIGN.md` § Density.
- `#Playground` blocks (`import Playgrounds`) only under `#if DEBUG`. They are exploration
  aids for Xcode, not a verification tier.

## Generated files (read-only)

None is committed; edit the generator or its inputs, never the output. A missing one means
`pnpm generate` (or `build-rust.sh`) has not run in this checkout.

| Output                                                                                                                   | Generator                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `CubbyKit/Sources/CubbyKit/Generated/native-coverage.json`                                                               | `packages/schemas/src/native-coverage.ts`                                                              |
| `Generated/{entity-manifest.json,EntityDescriptors,EntityVocabulary}.swift`, `CubbyAPISupport/Generated/EntityKey.swift` | `scripts/generator/entities/render/swift-catalog.ts`                                                   |
| `Generated/{OperationRoutes,ClientOperations,APITypes}.swift`, `Sources/CubbyAPI/openapi-generator-config.yaml`          | `scripts/generator/http-api/native.ts`, `swift-operations.ts`                                          |
| `Generated/entity-kernel.json`                                                                                           | `scripts/generator/http-api/entity-kernel.ts`                                                          |
| `Generated/SharedConstants.swift`                                                                                        | `packages/shared/src/client-constants.ts`, `apps/web/wrangler.jsonc`, `WAYFINDING_DOMAIN_PRESENTATION` |
| `CubbyAPI` target                                                                                                        | swift-openapi-generator plugin, from `Sources/CubbyAPI/openapi.json` (written by `pnpm generate`)      |
| `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift`                                                                              | `uniffi-bindgen` via `scripts/ensure.ts apple-ffi`                                                     |
| `App/Shared/Previews/Fixtures/*.json`                                                                                    | `apps/web/scripts/apple-preview-fixtures.ts` (edit its overrides)                                      |

- **Native coverage.** `packages/schemas/src/native-coverage.ts` is the single declaration of
  which manifest renderer, slot, and hero-action ids native draws. A new web-only id is
  classified there (`unsupported` + reason, raising `NATIVE_UNSUPPORTED_CEILING` with a
  justification in review). An `implemented` hero action needs a plan in `nativeHeroActionPlans`
  that `HeroActionRunner` runs; a collection verb needs a plan in `nativeCollectionActionPlans`.
  A new verb is a plan plus (for a new RPC) a typed case in the runner, never per-entity Swift or
  a slot view. An `implemented` slot or control needs its view path (`DetailSlotRegistry`,
  `ListSlotRegistry`, `EntityFieldControl.drawing(for:)`), checked both ways by
  `NativeCoverageViewPathTests`.
- **Server-owned reports.** Report slots draw through the one `ReportDetailSlot`; every figure,
  candidate, verb and disabled reason is the server's. Writes go through the same operations web
  calls, behind the server's `disabledReason` and a fresh server check of exactly what is sent.
  `ReportChoiceAnswers` never preselects an answer and mints a new operation id per answer change.
- **Structured values.** `FieldDescriptor.valueSchema` (from the field's Zod input schema) is
  drawn by the one `StructuredValueControl`, so a new structured field is a declaration, not a
  view. A structured detail field declares `display.detailLabelPath`, `display.itemsPath`, or a
  `readPath` with `format`/`valueOptions`; never re-word a structure in Swift.
- **Manifest wire.** `packages/schemas/src/manifest-wire.ts` owns descriptor storage, labels, raw
  values, conformances, and initializer defaults. Change it, run `pnpm generate`, preserve
  Codable envelopes and decode defaults, and verify `EntityManifestTests` and the structured
  round-trip vectors. Native conveniences live in extensions in `Catalog/EntityManifest.swift`.
- **Client methods.** A `CubbyClient` method that is exactly one call with its JSON body (or a
  GET's generated `Input.Query`) is a `CLIENT_PASSTHROUGH_METHODS` entry in
  `swift-operations.ts`, not hand-written Swift; anything that maps or branches stays in
  `API/CubbyClient.swift`.
- Rules that exist on both platforms but are not shared code are pinned by JSON vectors in
  `packages/shared/golden-vectors/` (`gtin.json`, `image-url.json`, `bin-plan.json`,
  `display-format.json`, `household-day.json`, `collection-tag.json`). The Swift tests and the
  web/Rust tests read the same files; change a rule by editing the vector first, then both
  implementations.
- Value formatting is single-sourced in Rust (`recipebridge/src/display_format.rs` plus
  `format_amount_labeled`): `currency`, `signedCurrency`, bare numbers, `{value, unit}` amounts, and
  nutrition/cost estimates (the compact cell and the long `DisplayFormat.estimate` form) run the
  same code as web (WASM) and native (UniFFI `format_*` in `cubby-ffi`, wrapped by `CubbyKit`
  `ValueFormat`). Declared list totals arrive worded by the server (`ListPageMeta.totalLabels`);
  `ListTotalsSummary` only prints them. The Rust tests read `display-format.json`
  directly; `DisplayFormatTests` and the web `display-format.unit.test.ts` are binding checks. Only
  `plainDate` stays per platform (no timezone database in Rust; `DisplayFormat.plainDate` /
  `formatCalendarDay`) and timestamps stay locale-aware platform code. Never format a catalog value
  with `.formatted()` in a view, and never re-implement a rule in Swift or TypeScript: edit the
  vector, then Rust.
- Recipe scaling is single-sourced in Rust too (`recipebridge/src/scaling.rs` plus `scale_amount`):
  web calls it as WASM, native through `cubby-ffi`'s `scale_*` exports wrapped by CubbyKit
  `RecipeScaling`/`RecipeCookPlan`. Swift never multiplies an amount or clamps a factor; which
  units scale (not a pan size or oven temperature) is Rust's call.
- Never restate a `SharedConstants` value in Swift. The GTIN rule itself is single-sourced in
  `recipebridge::scan_code_gtin14` (ISBN-10/13 or 8/12/13/14 digits; general GTIN check digits
  are not enforced).

## Verification

- `pnpm apple <cli|mac|ios|sim|gen|test>` from the repo root launches each product (README "Running").
- `swift build --package-path apps/apple/CubbyKit`
- `swift test --package-path apps/apple/CubbyKit`
- `xcodegen generate --spec apps/apple/project.yml` (when `project.yml` changes)
- App builds prepare the xcframework through the shared preparation entrypoint.
- `swift format lint --strict --configuration apps/apple/.swift-format --recursive` (see
  `scripts/apple-check.sh`, the `apple:lint` Nx target) gates
  formatting; run
  `swift format --in-place --configuration apps/apple/.swift-format --recursive` to fix.
  Keep copied Markdown fixtures/resources in the native build inputs; [CI](../../docs/ci.md) owns the
  hosted Apple lanes and cached-pass replay.
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

- Multiple Buttons within one `List` row use `.buttonStyle(.borderless)` so each receives
  only its own tap. Automatic row button styling can dispatch adjacent actions together;
  the report's Attach products control must open the product sheet alone.
- macOS sandbox entitlements on the iOS target make `simctl launch` hang on a black screen with
  no error and no process — targets keep per-platform entitlements files.
- `build-rust.sh --targets sim` writes a ONE-slice xcframework; a macOS build or CLI link then
  fails "no library for this platform". Run `--targets all` first. Never run two cargo commands
  against the shared `CARGO_TARGET_DIR` at once.
- Without a workspace lockfile Xcode serializes the app graph into the local
  `CubbyKit/Package.resolved`. `project.yml` links the tracked
  `apps/apple/Package.resolved` into the generated workspace; keep app pins
  there and Kit pins in CubbyKit's file ([ITERATION.md](ITERATION.md#build-reuse-and-a-clean-checkout)).
- Never open an unsigned (`CODE_SIGNING_ALLOWED=NO`) Mac build under
  `com.nickysemenza.cubby`: its cdhash requirement replaces the macOS privacy
  grants and the next team-signed build prompts again. `pnpm apple mac` checks.
- The CLI's ad-hoc signature changes every rebuild, so Keychain re-prompts; it uses a file token
  store under Application Support instead. `URL.path()` percent-encodes — use
  `path(percentEncoded: false)` for FileManager.
- The API emits `.000Z` timestamps the generated client rejects; use `Configuration.cubby`
  (`LenientISO8601DateTranscoder`). Product list rows carry no image URLs (`coverImageUrl` is on
  detail only); image `status` is `PENDING|UPLOADED|FAILED`.
- A generator never emits one giant array literal: Release/WMO stalls single-threaded in the
  SIL `COWArrayOpt` pass. Large catalogs ship as bundled JSON decoded at runtime.
- `Cubby.xcodeproj` is generated and gitignored; Git operations do not regenerate it. Run `pnpm apple gen` after
  switching branches before opening Xcode directly, so newly added Swift files appear in the
  project ("Cannot find … in scope").
- Running `knip --cache` before `packages/wasm` exists poisons `node_modules/.cache/knip`
  ("Unresolved imports …recipebridge_bg.js" on every later pre-commit); `rm -rf` that cache.
- Symptom: a re-presented `.sheet(item:)` shows the previous item's state even though the item's
  `id` changed. Rule: state lifetime follows the data's identity — own the model in the presenter
  (build it alongside the item) or resync with `.task(id:)`; never seed `@State`/`@StateObject`
  from an init parameter. Gated by `apple-check.sh`'s `State(initialValue:`/
  `StateObject(wrappedValue:` grep (tag a deliberate exception `// state-init-ok: <reason>`).

### Root scripts

Do not run root `pnpm` scripts from here — `apps/apple/**` and `cubby-ffi/**` are excluded from
oxfmt/oxlint (Swift is covered by its own `swift-format` gate above, not oxfmt/oxlint), and
running root pnpm scripts early can rewrite Swift-adjacent JSON fixtures.
