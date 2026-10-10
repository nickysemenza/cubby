import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

nonisolated private final class SearchModelStub: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, Data)
    static let handler = Mutex<Handler?>(nil)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler.withLock({ $0 }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        // Off the loading thread, so a handler parked on a Gate cannot stall a later request.
        let request = request
        DispatchQueue.global().async {
            let (status, data) = handler(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: data)
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [self]
        return URLSession(configuration: configuration)
    }
}

@MainActor
@Suite("SearchModel", .serialized)
struct SearchModelTests {
    @Test(.timeLimit(.minutes(1)))
    func laterQueryPublishesWithoutWaitingForOrAcceptingTheEarlierResponse() async throws {
        defer { SearchModelStub.handler.withLock { $0 = nil } }
        let requestedQueries = Mutex<[String]>([])
        let first = Gate()
        defer { first.open() }
        SearchModelStub.handler.withLock { handler in
            handler = { request in
                let query = Self.queryItem("query", in: request) ?? ""
                requestedQueries.withLock { $0.append(query) }
                if query == "first" { first.holdBlocking() }
                return (200, Self.searchPayload(title: query))
            }
        }
        let model = SearchModel(client: try makeClient())

        model.query = "first"
        model.retry()
        await first.arrivals(1)
        model.query = "second"
        model.retry()
        // The earlier response is still held while the later one publishes.
        await model.searchTask?.value

        #expect(Self.resultTitle(in: model.phase) == "second")
        #expect(requestedQueries.withLock { $0.contains("second") })
    }

    @Test(.timeLimit(.minutes(1)))
    func changingScopeInvalidatesVisibleResultsImmediatelyAndUsesTheLatestScope() async throws {
        defer { SearchModelStub.handler.withLock { $0 = nil } }
        let entityKinds = Mutex<[String]>([])
        SearchModelStub.handler.withLock { handler in
            handler = { request in
                entityKinds.withLock { values in
                    values =
                        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                        .queryItems?.filter { $0.name == "entityKinds" }.compactMap(\.value) ?? []
                }
                return (200, Self.searchPayload(title: "scoped"))
            }
        }
        let model = SearchModel(client: try makeClient())
        model.query = "hammer"
        model.scope = .product

        #expect(model.phase == .searching)
        model.retry()
        await model.searchTask?.value

        #expect(Self.resultTitle(in: model.phase) == "scoped")
        #expect(entityKinds.withLock { $0 } == ["product"])
    }

    @Test(.timeLimit(.minutes(1)))
    func queryChangeCancelsAStaleSubmittedCodeLookup() async throws {
        defer { SearchModelStub.handler.withLock { $0 = nil } }
        let lookup = Gate()
        defer { lookup.open() }
        SearchModelStub.handler.withLock { handler in
            handler = { _ in
                lookup.holdBlocking()
                return (500, Data(#"{"code":"TEST","message":"cancelled"}"#.utf8))
            }
        }
        let model = SearchModel(client: try makeClient())
        model.query = "012345678905"
        let submitted = Task { await model.submit() }
        await lookup.arrivals(1)

        model.query = "new words"
        let outcome = await submitted.value

        #expect(outcome == .text("new words"))
        #expect(model.lookupOutcome == nil)
        #expect(model.phase == .searching)
    }

    @Test(.timeLimit(.minutes(1)))
    func watcherDoesNotKeepADiscardedSearchModelAlive() async throws {
        let defaults = UserDefaults.standard
        let recentsKey = "cubby.intents.recent"
        let savedRecents = defaults.object(forKey: recentsKey)
        defaults.removeObject(forKey: recentsKey)
        defer {
            if let savedRecents {
                defaults.set(savedRecents, forKey: recentsKey)
            } else {
                defaults.removeObject(forKey: recentsKey)
            }
        }

        var model: SearchModel? = SearchModel(client: try makeClient())
        await model?.start()
        #if compiler(>=6.4)
            weak let discarded = model
        #else
            weak var discarded = model
        #endif
        model = nil
        await Task.yield()

        #expect(discarded == nil)
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: SearchModelStub.session()
        )
    }

    nonisolated private static func queryItem(_ name: String, in request: URLRequest) -> String? {
        URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == name })?.value
    }

    nonisolated private static func searchPayload(title: String) -> Data {
        let object: [[String: Any]] = [
            [
                "id": "PRD-2345", "entityKind": "product", "title": title,
                "subtitle": NSNull(), "typeHint": NSNull(), "imageUrl": NSNull(), "matchKind": "prefix",
                "matchField": "title", "matchReason": "", "matchTerms": [title],
            ]
        ]
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private static func resultTitle(in phase: SearchModel.Phase) -> String? {
        guard case .results(let groups) = phase else { return nil }
        return groups.first?.hits.first?.title
    }
}
