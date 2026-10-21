# CubbyAPI — generated at build time

This target has no committed Swift. swift-openapi-generator's SwiftPM build
plugin (`OpenAPIGenerator`, declared in `CubbyKit/Package.swift`) generates the
typed client from `openapi.json` and `openapi-generator-config.yaml` in this
directory. Both are gitignored and written by `pnpm generate`
(`apps/web/generator/http-api/`), which install, the Xcode scheme pre-action
and `pnpm apple gen` run. The document is the whole
HTTP API, which carries only the contract members flagged `native:`, so the
generator config has no operation filter. The entity kernel operations and the
`entity.listBase`, `entity.listEnrichment`, and `entity.listSummary` lists are
untyped JSON objects here (`JSON_VALUE_COMPONENTS` in `openapi.ts`). Project
analytics use shared report presentation, and Run responses use the validated
`RunSnapshot` consumer adapter over `JSONValue`; their unused generated graphs
are also erased from this native document. The server still validates the full
schemas. Entity rows use the manifest; records with remaining typed consumers
stay typed through `NATIVE_TYPED_RECORDS` (`type-overrides.ts`).

Reusable domain schemas keep semantic enums shared. After normalization the
emitter folds anonymous schemas with identical validation constraints, while
retaining distinct named domain types. Inventory and task mutation results use
Apple's supported `typeOverrides.schemas` to alias their concrete outputs to
`CubbyAPISupport.MutationResult<Item, Effects>`. Its required keys and open
response decoding match the generated result contract; changes to the wrapper
shape fail generation rather than silently dropping a new field.

Positional `_schemaNN` names are assigned at schema registration and can
renumber when a new schema is added; `apps/apple/AGENTS.md` forbids naming
those in hand-written Swift for exactly that reason.

Hand-written code names these types only through the aliases in
`CubbyKit/Sources/CubbyKit/Generated/APITypes.swift`; see `apps/apple/AGENTS.md`.
