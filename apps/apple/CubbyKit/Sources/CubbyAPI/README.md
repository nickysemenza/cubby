# CubbyAPI — generated at build time

This target has no committed Swift. swift-openapi-generator's SwiftPM build
plugin (`OpenAPIGenerator`, declared in `CubbyKit/Package.swift`) generates the
typed client from `openapi.json` and `openapi-generator-config.yaml` in this
directory. Both are gitignored and written by `pnpm generate`
(`apps/web/generator/http-api/`), which install, the Xcode scheme pre-action
and `apps/apple/scripts/prepare-project.sh` run. The document is the whole
HTTP API, which carries only the contract members flagged `native:`, so the
generator config has no operation filter. The entity kernel operations and the
`entity.listBase`, `entity.listEnrichment`, and `entity.listSummary` lists are
untyped JSON objects here (`JSON_VALUE_COMPONENTS` in `openapi.ts`): native
reads them as `JSONValue` through the entity manifest, so per-entity variants
would be compile cost only. A few records hand-written Swift decodes by name
stay typed through `NATIVE_TYPED_RECORDS` (`type-overrides.ts`).

Positional `_schemaNN` names are assigned at schema registration and can
renumber when a new schema is added; `apps/apple/AGENTS.md` forbids naming
those in hand-written Swift for exactly that reason.

Hand-written code names these types only through the aliases in
`CubbyKit/Sources/CubbyKit/Generated/APITypes.swift`; see `apps/apple/AGENTS.md`.
