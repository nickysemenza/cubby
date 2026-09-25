# CubbyAPI — generated at build time

This target has no committed Swift. swift-openapi-generator's SwiftPM build
plugin (`OpenAPIGenerator`, declared in `CubbyKit/Package.swift`) generates the
typed client from `openapi.json` and `openapi-generator-config.yaml` in this
directory. Both are gitignored and written by `pnpm generate`
(`scripts/generator/http-api/`), which install, the Xcode scheme pre-action
and `apps/apple/scripts/prepare-project.sh` run.

Positional `_schemaNN` names are assigned at schema registration and can
renumber when a new schema is added; `apps/apple/AGENTS.md` forbids naming
those in hand-written Swift for exactly that reason.

Hand-written code names these types only through the aliases in
`CubbyKit/Sources/CubbyKit/Generated/APITypes.swift`; see `apps/apple/AGENTS.md`.
