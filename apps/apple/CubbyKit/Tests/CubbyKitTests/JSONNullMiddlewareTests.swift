import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class JSONNullStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
    static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
}

/// The generated client encodes an optional with `encodeIfPresent`, so a typed body can never
/// say `null`; `CubbyClient.sending(_:_:)` restores the composed body's nulls through
/// `JSONNullMiddleware`. These pin the exact bytes a real save puts on the wire.
@Suite("JSONNullMiddleware wire shape", .serialized)
struct JSONNullMiddlewareTests {
    private struct Seen: Sendable {
        let method: String?
        let path: String
        let body: [String: JSONValue]
        let contentLength: String?
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!, credentials: credentials,
            session: JSONNullStub.session())
    }

    /// Captures every request; the stub rejects with a bare `ApiError` so the test stays about
    /// the outgoing body rather than response mapping.
    private func capture(_ body: (CubbyClient) async throws -> Void) async throws -> [Seen] {
        defer { JSONNullStub.handler.withLock { $0 = nil } }
        let seen = Mutex<[Seen]>([])
        JSONNullStub.handler.withLock { handler in
            handler = { request in
                let data = (try? Self.requestBody(request)) ?? Data()
                let fields = (try? JSONDecoder().decode([String: JSONValue].self, from: data)) ?? [:]
                seen.withLock {
                    $0.append(
                        Seen(
                            method: request.httpMethod, path: request.url?.path ?? "", body: fields,
                            contentLength: request.value(forHTTPHeaderField: "Content-Length")))
                }
                return (400, Data(#"{"code":"VALIDATION","message":"rejected by stub"}"#.utf8))
            }
        }
        try await body(try makeClient())
        return seen.withLock { $0 }
    }

    private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        let stream = try #require(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    @Test func clearedKeysBecomeNullBesideTheTypedValues() async throws {
        let requests = try await capture { client in
            await #expect(throws: CubbyAPIError.self) {
                try await client.update(
                    EntityCatalog[.product], id: "PRD-2345",
                    patch: EntityPatch(values: ["manufacturer": "Lodge"], cleared: ["categoryId"]))
            }
        }
        let request = try #require(requests.first)
        #expect(requests.count == 1)
        #expect(request.method == "PATCH")
        #expect(request.path == "/api/v1/products/PRD-2345")
        #expect(request.body == ["manufacturer": "Lodge", "categoryId": .null])
        // The rewritten body's length, not the generated client's.
        #expect(request.contentLength == String(try JSONEncoder().encode(request.body).count))
    }

    /// A required, nullable key inside a structured value (an alias's `externalAccountId`) is
    /// sent as `null`. The typed body would drop it, and the server rejects the absent key
    /// ("expected string, received undefined").
    @Test func aNestedNullInAnUpdateReachesTheWire() async throws {
        let aliases: JSONValue = [
            ["source": "synthetic-bank", "alias": "SYN CHK 0001", "externalAccountId": .null]
        ]
        let requests = try await capture { client in
            await #expect(throws: CubbyAPIError.self) {
                try await client.update(
                    EntityCatalog[.financialAccount], id: "FAC-2345",
                    patch: EntityPatch(values: ["sourceAliases": aliases]))
            }
        }
        #expect(requests.map(\.body) == [["sourceAliases": aliases]])
    }

    /// Restoring nulls buffers the body; a body with none must not inherit that buffer's limit.
    @Test func aLargeBodyWithoutNullsIsSentUnchanged() async throws {
        let notes = String(repeating: "a", count: 2 << 20)
        let requests = try await capture { client in
            await #expect(throws: CubbyAPIError.self) {
                try await client.update(
                    EntityCatalog[.product], id: "PRD-2345",
                    patch: EntityPatch(values: ["notes": .string(notes)]))
            }
        }
        #expect(requests.map(\.body) == [["notes": .string(notes)]])
    }

    @Test func aNestedNullInACreateReachesTheWire() async throws {
        let aliases: JSONValue = [
            ["source": "synthetic-bank", "alias": "SYN CHK 0001", "externalAccountId": .null]
        ]
        let body: [String: JSONValue] = [
            "name": "Synthetic checking", "identity": ["kind": "cash"], "sourceAliases": aliases,
        ]
        let requests = try await capture { client in
            await #expect(throws: CubbyAPIError.self) {
                _ = try await client.create(EntityCatalog[.financialAccount], body: body)
            }
        }
        #expect(requests.map(\.body) == [body])
    }

    /// With nothing cleared the middleware must not touch the body: an update that only changes
    /// values keeps the generated client's omitted-field semantics for everything else.
    @Test func nothingClearedLeavesTheTypedBodyAlone() async throws {
        let requests = try await capture { client in
            await #expect(throws: CubbyAPIError.self) {
                try await client.update(
                    EntityCatalog[.location], id: "LOC-2345",
                    patch: EntityPatch(values: ["name": "Garage shelf"]))
            }
        }
        #expect(requests.map(\.body) == [["name": "Garage shelf"]])
    }

    /// The cleared set is scoped to the one update: a following attachment patch on the same
    /// client never inherits it (it would clear the field again on the server).
    @Test func clearedKeysDoNotLeakIntoALaterPatch() async throws {
        let requests = try await capture { client in
            await #expect(throws: CubbyAPIError.self) {
                try await client.update(
                    EntityCatalog[.product], id: "PRD-2345", patch: EntityPatch(cleared: ["notes"]))
            }
            await #expect(throws: CubbyAPIError.self) {
                try await client.attachImages(
                    [ImageCode("IMG-2345")], to: EntityCatalog[.product], id: "PRD-2345")
            }
        }
        #expect(
            requests.map(\.body) == [
                ["notes": .null],
                ["pendingImageIds": ["IMG-2345"]],
            ])
    }

    /// A value the update schema rejects fails in the typed decode, before any request exists.
    @Test func aValueTheSchemaRejectsNeverReachesTheWire() async throws {
        let requests = try await capture { client in
            await #expect(throws: DecodingError.self) {
                try await client.update(
                    EntityCatalog[.product], id: "PRD-2345",
                    patch: EntityPatch(values: ["categoryId": ["unexpected": "object"]]))
            }
        }
        #expect(requests.isEmpty)
    }

    @Test func anEmptyPatchSendsNothing() async throws {
        let requests = try await capture { client in
            try await client.update(EntityCatalog[.product], id: "PRD-2345", patch: EntityPatch())
        }
        #expect(requests.isEmpty)
    }

    /// `run` is declared read-only, so it has no update operation in the HTTP document and stays
    /// unsupported even once every declared update operation is generated.
    @Test func anEntityWithoutAnUpdateOperationIsUnsupported() async throws {
        let requests = try await capture { client in
            await #expect(throws: EntityOperationError.unsupported(.run, .update)) {
                try await client.update(
                    EntityCatalog[.run], id: "RUN-2345", patch: EntityPatch(values: ["name": "Basics"]))
            }
        }
        #expect(requests.isEmpty)
    }
}
