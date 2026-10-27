# CubbyAPI — generated native models

`pnpm generate` derives the native interface directly from every query and
mutation in Cubby's operation contracts, using the same JSON wire projections
as the shared operation handler. There is no per-client operation allowlist or
SwiftPM code-generation plugin.

`apps/web/generator/http-api/native-contract.ts` collects the projected contracts;
`swift-models.ts` emits plain Codable, Hashable, Sendable Swift models under
`Models/`. Generated files are ignored and restored by the generation task.
Handwritten callers name models through CubbyKit's generated `APITypes.swift`.
Branded identifiers, dates and JSON codecs live in `CubbyAPISupport`.
Anonymous discriminator members retain their full path from the nearest named
schema, so a nested value arm cannot claim its containing object's model name.
Recursive stored properties use `NativeIndirect`, including self references
hidden behind named aliases; child arrays retain their ordinary value semantics.
CubbyKit's `LenientISO8601DateTranscoder` preserves server milliseconds when
encoding dates, including photo-review revisions used by stale-write guards.

`NativeOperations.swift` contains methods for operation ids and
`OperationCatalog.swift` lists those ids for the CLI. `NativeHTTPTransport` POSTs
to `/api/operations/{operationId}` with the operation envelope and owns URLSession
requests, authentication snapshots, credential rotation, cancellation,
diagnostics and request observation. Responses use `{ok: true, data}`; errors
use the shared public `ApiError` body. Response headers update credentials and
the client-update latch before body consumption, including interrupted bodies.
Nullable output values decode as Output?.

Manifest-driven editors, commands and entity kernel operations send composed
JSON directly. Their server declarations remain authoritative for validation;
client form validation still provides immediate feedback. A declaration can
select a JSON representation with `nativeModels` without weakening its server
schema. Specialized native experiences retain their typed models. Retained record roots
enter the same wire projection once as operation outputs. Their CubbyKit aliases
refer to the registered model even when another exported name owns that schema;
generation must not clone a second wire model to preserve an alias. Inventory
recounts consume the canonical `InventoryDetail` amount outcome.

Models distinguish required nullable keys from omitted keys. Optional nullable
fields use `NativeField` to preserve absent, null and value states, including
nullable named schema references. Unknown enum
values and union variants retain their raw value. Callers must show unsupported
state and disable interpretation-dependent actions rather than reinterpret an
unknown value as an existing case. Malformed known discriminated variants fail
decoding. Additional response fields are ignored.

Generation rejects conflicting operation identities, unsupported success
statuses, path parameters, divergent error schemas and unsupported model shapes.
Every error status uses the shared diagnostic response; transport throws one
`CubbyAPIError` containing the actual status and raw response body. Native hero
and collection action plans are checked against the same declarations.
