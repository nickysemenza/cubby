import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

nonisolated private final class ActivityListStub: URLProtocol, @unchecked Sendable {
    static let paths = Mutex<[String]>([])
    static let observer = Mutex<AsyncStream<String>.Continuation?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let path = request.url!.path
        Self.paths.withLock { $0.append(path) }
        Self.observer.withLock { $0 }?.yield(path)
        let body: Data
        if path == "/api/v1/activity/groups" {
            body = Self.groups
        } else if path == "/api/v1/activity/groupChildren" {
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "cursor" }?.value
            body = Self.children(secondPage: cursor != nil)
        } else {
            body = Self.empty
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    static func children(secondPage: Bool) -> Data {
        let groups = try! JSONSerialization.jsonObject(with: Self.groups) as! [String: Any]
        let items = groups["items"] as! [[String: Any]]
        var row = items[0]["root"] as! [String: Any]
        row["id"] = secondPage ? "RUN-4K7P" : "RUN-4K7N"
        row["parentRunId"] = "RUN-4K7M"
        row["state"] = "running"
        row["active"] = true
        return try! JSONSerialization.data(withJSONObject: [
            "items": [row], "total": 2,
            "nextCursor": secondPage ? NSNull() : "child-page-2",
        ])
    }

    static let empty = Data(#"{"items":[],"total":0,"nextCursor":null}"#.utf8)
    static let groups = Data(
        #"{"items":[{"root":{"id":"RUN-4K7M","recordType":"run","parentRunId":null,"kind":"mail_discovery","trigger":null,"vendorAccountId":null,"vendorId":null,"ledgerPartyId":null,"subjectId":null,"subjectName":"Sample discovery","iconEntity":"run","dataQuality":null,"subjectImage":null,"workLabel":"Mail discovery","currentStep":null,"targetCounts":null,"targetSummary":null,"targetPreview":[],"changedCount":0,"state":"completed","active":false,"createdAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:00:01Z","durationMs":1000,"attempts":1,"executors":[],"estimatedCost":null,"error":null,"hasDiagnostics":false,"canRetry":false},"active":true,"workCounts":{"working":1,"waiting":0,"needsReview":0,"failed":0,"completed":1,"skipped":0},"childCount":1,"contextOnly":false,"latestAt":"2026-01-01T00:00:02Z"}],"total":1,"totalItems":2,"nextCursor":null}"#
            .utf8)
}

@MainActor
@Suite("Activity grouped list", .serialized)
struct ActivityListModelTests {
    @Test func childPagesAppendWithoutReplacingTheirRoot() async throws {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ActivityListStub.self]
        let client = CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: URLSession(configuration: configuration))
        let model = ActivityListModel()
        await model.load(client: client)
        await model.loadChildren(rootID: "RUN-4K7M", client: client)
        #expect(model.children["RUN-4K7M"]?.nextCursor == "child-page-2")
        await model.loadChildren(rootID: "RUN-4K7M", client: client, reset: false)
        #expect(model.children["RUN-4K7M"]?.items.map(\.id) == ["RUN-4K7N", "RUN-4K7P"])
        #expect(model.children["RUN-4K7M"]?.nextCursor == nil)
        #expect(model.runs.map(\.id) == ["RUN-4K7M"])
    }

    @Test func completedParentKeepsActiveChildGroupVisibleThroughRefresh() async throws {
        ActivityListStub.paths.withLock { $0 = [] }
        defer { ActivityListStub.paths.withLock { $0 = [] } }
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ActivityListStub.self]
        let client = CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: URLSession(configuration: configuration))
        let model = ActivityListModel()
        await model.load(client: client)
        #expect(model.runs.count == 1)
        #expect(model.runs.first?.state == "completed")
        await model.refreshLoaded(client: client)
        #expect(model.runs.count == 1)
        #expect(
            ActivityListStub.paths.withLock { $0 } == [
                "/api/v1/activity/groups", "/api/v1/activity/groups",
            ])
        let (requests, continuation) = AsyncStream<String>.makeStream()
        ActivityListStub.observer.withLock { $0 = continuation }
        let poll = Task { await model.pollActive(client: client) }
        let deadline = Task {
            try? await Task.sleep(for: .seconds(2))
            continuation.finish()
        }
        defer {
            poll.cancel()
            deadline.cancel()
            continuation.finish()
            ActivityListStub.observer.withLock { $0 = nil }
        }
        var iterator = requests.makeAsyncIterator()
        #expect(await iterator.next() == "/api/v1/activity/groups")
    }
}
