# CubbyAPI — generated at build time

This target has no committed Swift. swift-openapi-generator's SwiftPM build
plugin (`OpenAPIGenerator`, declared in `CubbyKit/Package.swift`) generates the
typed client from `openapi.json` and `openapi-generator-config.yaml` in this
directory. Both are gitignored and written by `pnpm generate`
(`scripts/generator/http-api/`), which install, the Xcode scheme pre-action
and `apps/apple/scripts/prepare-project.sh` run. The Apple document contains
only automatic resource operations and RPC operations flagged `native:`, with
their reachable components, discriminator mappings, and security metadata. The
web document remains the complete HTTP API; edits to unused HTTP contracts do
not rewrite the Apple document. The same operation selection writes the Swift
generator config. Redocly bundles the projection and removes unused components,
so reference and security handling follow the maintained OpenAPI tooling.
The `entity.listBase`, `entity.listEnrichment`, and `entity.listSummary`
responses are untyped objects here (`nativeComponents` in
`native-document.ts`): native lists read them as `JSONValue` through the
entity manifest, so their per-entity variants were compile cost only. The
wire format is unchanged.

Positional `_schemaNN` names are assigned at schema registration and can
renumber when a new schema is added; `apps/apple/AGENTS.md` forbids naming
those in hand-written Swift for exactly that reason.

Hand-written code names these types only through the aliases in
`CubbyKit/Sources/CubbyKit/Generated/APITypes.swift`; see `apps/apple/AGENTS.md`.
