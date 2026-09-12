# apps/apple agent rules

Native PoC: SwiftUI (iOS 26 / macOS 26) + `CubbyKit` package + `cubby` CLI harness. Full plan:
`/Users/nicky/.claude/plans/moonlit-juggling-finch.md`.

## Build order

`apps/apple/scripts/build-rust.sh` → `apps/apple/scripts/generate-openapi.sh` → `xcodegen generate
--spec apps/apple/project.yml`. If a build fails with the literal text `artifact of binary target
'CubbyFFIBinary' not found`, the xcframework is missing — run `build-rust.sh` first.

## Wire rules (non-negotiable)

- Send `Origin: cubby-mobile://` on every `/api/auth/*` request (Better Auth trusts this origin;
  omitting it fails sign-in).
- Store the `set-auth-token` response header verbatim in Keychain. If a *later* `/api/auth/*`
  response carries a different `set-auth-token`, overwrite the stored value — do not keep the
  first one.
- Never name a `Components.Schemas.*_schemaNN` type in hand-written Swift. Those are
  swift-openapi-generator's positional names for an 1,016-schema doc and are not stable across
  regeneration. Map generated types into hand-authored `Sendable` structs at the boundary, in
  `CubbyKit/Sources/CubbyKit/API/Mapping.swift`.
- Always pass `serverURL` explicitly when constructing a generated `Client`. The spec's `servers`
  entry is `"/"`, which is not a usable absolute URL on its own.

## Language and style

- Swift 6 strict concurrency (`swiftLanguageModes: [.v6]`). No unchecked `Sendable` escapes without
  a comment explaining why.
- Observation (`@Observable`), not Combine, for view state.
- Swift Testing (`import Testing`, `@Test`, `#expect`) for all tests. Never XCTest.
- Every SwiftUI view gets a `#Preview`, fed by `PreviewFixtures` where practical.
- `#Playground` blocks (`import Playgrounds`) only under `#if DEBUG`. They are exploration
  aids for Xcode, not a verification tier.

## Generated files (read-only; owned by W1)

- `CubbyKit/Sources/CubbyKit/Generated/EntityCatalog.swift` — from
  `scripts/entity-generator/render/swift-catalog.ts`. Regenerate with `pnpm entity:generate`
  (repo root).
- `CubbyKit/Sources/CubbyFFI/cubby_ffi.swift` — from `uniffi-bindgen`. Regenerate with
  `apps/apple/scripts/build-rust.sh`.

Hand-editing either fails its `--check` gate. If one is missing (W1 hasn't landed yet), a stub at
the same path is expected — do not fabricate the real generated shape.

## Verification

- `swift build --package-path apps/apple/CubbyKit`
- `swift test --package-path apps/apple/CubbyKit`
- `xcodegen generate --spec apps/apple/project.yml` (only once `project.yml` exists)
- Full app build needs the xcframework from `build-rust.sh` first; that script and its inputs
  belong to W1.

Do not run root `pnpm` scripts from here — `apps/apple/**` and `cubby-ffi/**` are excluded from
oxfmt/oxlint until W1's tooling change lands, and running them early can rewrite Swift-adjacent
JSON fixtures.
