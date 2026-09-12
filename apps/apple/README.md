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
   `CubbyKit/Sources/CubbyKit/Generated/{Types,Client}.swift`.
3. `xcodegen generate --spec apps/apple/project.yml` — produces `Cubby.xcodeproj` (gitignored).

If you see the literal error text `artifact of binary target 'CubbyFFIBinary' not found`, the
xcframework hasn't been built yet — run step 1 (`build-rust.sh`) first.

## Ownership

Another agent/workstream (W1) owns `apps/apple/scripts/build-rust.sh`,
`CubbyKit/Sources/CubbyFFI/`, `CubbyKit/Frameworks/`, and
`CubbyKit/Sources/CubbyKit/Generated/EntityCatalog.swift`. Everything else under `apps/apple/` is
owned by W2 (this package, the app targets, and the CLI harness).

## Generated files (read-only here)

- `CubbyKit/Sources/CubbyKit/Generated/EntityCatalog.swift` — emitted by
  `scripts/entity-generator/render/swift-catalog.ts` from the entity spine. Regenerate with
  `pnpm entity:generate` from the repo root.
- `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift` — emitted by `uniffi-bindgen` from `cubby-ffi/`.
  Regenerate with `apps/apple/scripts/build-rust.sh`.

Both are committed; hand-editing either fails the relevant `--check` gate.

## Verification

- `swift build --package-path apps/apple/CubbyKit`
- `swift test --package-path apps/apple/CubbyKit`
- `swift run --package-path apps/apple/CubbyKit cubby -- --help` (CLI harness; no Xcode scheme)
- `xcodegen generate --spec apps/apple/project.yml` then
  `xcodebuild -project apps/apple/Cubby.xcodeproj -scheme Cubby-iOS -destination 'generic/platform=iOS Simulator' build`
  for the app targets (needs the xcframework from step 1 first)
