# CubbyAPI — generated native models

`pnpm generate` derives the native interface directly from Cubby's operation and
entity declarations, using the same wire projections as the HTTP handler. Only
operations marked `native:` are included. There is no OpenAPI document or SwiftPM
code-generation plugin.

`apps/web/generator/http-api/native-contract.ts` collects the projected contracts;
`swift-models.ts` emits plain Codable, Hashable, Sendable Swift models under
`Models/`. Generated files are ignored and restored by the generation task.
Handwritten callers name models through CubbyKit's generated `APITypes.swift`.
Branded identifiers, dates and JSON codecs live in `CubbyAPISupport`.

`NativeOperations.swift` contains payload-returning methods and
`OperationRoutes.swift` contains their operation identities and routes. One
`NativeHTTPTransport` owns URLSession requests, authentication snapshots,
credential rotation, cancellation, diagnostics and request observation. The
server's existing HTTP paths, JSON payloads and client-update enforcement remain
the wire contract. Response headers update credentials and the client-update latch
before body consumption, including interrupted bodies. Flat queries repeat array
keys and percent-encode literal plus signs for the server query parser.

Manifest-driven editors, commands and entity kernel operations send composed
JSON directly. Their server declarations remain authoritative for validation;
client form validation still provides immediate feedback. A declaration can
select a JSON representation with `nativeModels` without weakening its server
schema. Specialized native experiences retain their typed models.

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
