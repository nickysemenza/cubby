# CubbyAPI — generated, do not edit

Every `*.swift` file in this directory is swift-openapi-generator output,
produced by `apps/apple/scripts/generate-openapi.sh` from
`apps/web/src/lib/generated/http-openapi.gen.json`. `check-openapi-drift.sh`
fails CI when the committed copy is stale.

The generator renders in document order, and the JSON emits `paths` and
`components.schemas` sorted, so adding an operation changes only the lines
that describe it. Positional `_schemaNN` names are assigned at schema
registration and can still renumber when a new *schema* (not operation) is
added; `apps/apple/CLAUDE.md` forbids naming those in hand-written Swift for
exactly that reason.

Hand-written code names these types only in the five files listed in
`apps/apple/CLAUDE.md`; map them into `Sendable` structs at that boundary.
