import Foundation
import Synchronization
import Testing

@testable import CubbyKit

// The per-suite handler is protected by Mutex; URLProtocol owns instance callbacks.
// This stub needs response headers, which StubNetworking does not model.
private final class DebugClientStubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, [String: String], Data)
    static let handler = Mutex<Handler?>(nil)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler.withLock({ $0 }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, headers, data) = handler(request)
        var responseHeaders = headers
        responseHeaders["Content-Type"] = responseHeaders["Content-Type"] ?? "application/json"
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: responseHeaders
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DebugClientStubURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

@Suite("CubbyDebugClient", .serialized)
struct DebugClientTests {
    @Test func replaysAndRefreshesTheSignedSessionDataCache() async throws {
        defer { DebugClientStubURLProtocol.handler.withLock { $0 = nil } }
        let store = InMemorySessionTokenStore()
        try store.saveState(
            CubbyAuthState(
                credential: .bearer("tok"),
                sessionDataCookies: ["better-auth.session_data": "before"]
            ),
            for: "cubby.example"
        )
        let credentials = CredentialProvider(host: "cubby.example", store: store)
        let client = CubbyDebugClient(
            baseURL: URL(string: "https://cubby.example")!,
            credentials: credentials,
            session: DebugClientStubURLProtocol.session()
        )
        DebugClientStubURLProtocol.handler.withLock { handler in
            handler = { request in
                #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_data=before")
                return (
                    200,
                    ["Set-Cookie": "better-auth.session_data=after; Max-Age=300; Path=/"],
                    Data("{}".utf8)
                )
            }
        }

        let route = try #require(OperationRoute.all["resources.product.list"])
        _ = try await client.call(route)

        #expect(
            await credentials.currentState()?.sessionDataCookies == [
                "better-auth.session_data": "after"
            ])
    }
}
