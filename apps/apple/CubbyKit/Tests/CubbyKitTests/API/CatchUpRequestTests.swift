import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class CatchUpStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
}

@Suite("Catch-up request", .serialized)
struct CatchUpRequestTests {
    /// The operation declares no input, so the envelope carries its operation id without an
    /// `input` member.
    @Test func sendsNoInputInTheOperationEnvelope() async throws {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let client = CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: StubNetworking.session(protocolClass: CatchUpStub.self))
        let sent = Mutex<(path: String, body: Data)?>(nil)
        CatchUpStub.handler.withLock { handler in
            handler = { request in
                var body = request.httpBody ?? Data()
                if let stream = request.httpBodyStream {
                    stream.open()
                    defer { stream.close() }
                    var buffer = [UInt8](repeating: 0, count: 256)
                    while case let count = stream.read(&buffer, maxLength: buffer.count), count > 0 {
                        body.append(contentsOf: buffer.prefix(count))
                    }
                }
                sent.withLock { $0 = (request.url?.path ?? "", body) }
                return (200, Data(#"{"status":"queued"}"#.utf8))
            }
        }
        try await client.requestCatchUp()
        let request = try #require(sent.withLock { $0 })
        #expect(request.path == "/api/operations/maintenance.requestCatchUp")
        let envelope = try JSONDecoder().decode(JSONValue.self, from: request.body)
        #expect(envelope["operation"] == "maintenance.requestCatchUp")
        #expect(envelope["input"] == nil)
    }
}
