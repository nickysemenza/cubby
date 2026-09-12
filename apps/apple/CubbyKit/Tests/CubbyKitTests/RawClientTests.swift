import Foundation
import Synchronization
import Testing

@testable import CubbyKit

/// A URLProtocol that answers every request from a handler installed per test. Registered on a
/// private session configuration so it never touches the real network.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, Data)
    // Static mutable state guarded by a Mutex, which is the Swift 6-safe way to share a handler
    // with URLSession's loader thread.
    static let handler = Mutex<Handler?>(nil)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler.withLock({ $0 }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, data) = handler(request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

@Suite("CubbyRawClient", .serialized)
struct RawClientTests {
    private func makeClient(credential: CubbyCredential = .bearer("tok")) throws -> (CubbyRawClient, CredentialProvider) {
        let store = InMemorySessionTokenStore()
        try store.save(credential, for: "localhost:3000")
        let credentials = CredentialProvider(host: "localhost:3000", store: store)
        let client = CubbyRawClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: credentials,
            session: StubURLProtocol.session()
        )
        return (client, credentials)
    }

    @Test func listEncodesControlsAndUnwrapsEnvelope() async throws {
        let payload = try Fixtures.data(named: "products-list.json")
        StubURLProtocol.handler.withLock { handler in
            handler = { request in
                let url = request.url!
                #expect(url.path() == "/api/v1/products")
                let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
                #expect(items.contains(URLQueryItem(name: "page", value: "2")))
                #expect(items.contains(URLQueryItem(name: "pageSize", value: "10")))
                #expect(items.contains(URLQueryItem(name: "sort", value: "-name")))
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
                return (200, payload)
            }
        }
        let (client, _) = try makeClient()
        let page = try await client.list(basePath: "products", page: 2, pageSize: 10, sort: "-name")
        #expect(!page.items.isEmpty)
        #expect(page.meta.pageIndex >= 0)
        #expect(page.items.first?["id"]?.stringValue?.hasPrefix("PRD-") == true)
    }

    @Test func getSubstitutesPathID() async throws {
        let payload = try Fixtures.data(named: "product-get.json")
        StubURLProtocol.handler.withLock { handler in
            handler = { request in
                #expect(request.url!.path() == "/api/v1/products/PRD-2345")
                return (200, payload)
            }
        }
        let (client, _) = try makeClient()
        let product = try await client.get(basePath: "products", id: "PRD-2345")
        #expect(product["name"] == "Sample Product")
    }

    @Test func unauthorizedInvalidatesCredential() async throws {
        let payload = try Fixtures.data(named: "error-unauthorized.json")
        StubURLProtocol.handler.withLock { handler in
            handler = { _ in (401, payload) }
        }
        let (client, credentials) = try makeClient()
        await #expect(throws: CubbyAPIError.self) {
            _ = try await client.get(basePath: "products", id: "PRD-2345")
        }
        #expect(await credentials.current() == nil)
    }

    @Test func callPostsJSONBody() async throws {
        let payload = try Fixtures.data(named: "scan-added.json")
        StubURLProtocol.handler.withLock { handler in
            handler = { request in
                #expect(request.httpMethod == "POST")
                #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
                return (200, payload)
            }
        }
        let (client, _) = try makeClient()
        let data = try await client.call("inventory.scanAtLocation", body: ["locationId": "LOC-2345", "code": ["kind": "barcode", "value": "0"]])
        #expect(data["outcome"] == "added")
    }
}
