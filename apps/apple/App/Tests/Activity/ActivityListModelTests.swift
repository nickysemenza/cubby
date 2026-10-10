import CubbyKit
import Foundation
import Synchronization
import Testing

@testable import Cubby

nonisolated private final class ActivityListStub: URLProtocol, @unchecked Sendable {
    static let settled = Mutex(false)
    static let holdGroups = Mutex(false)
    static let heldGroup = Mutex<(@Sendable () -> Void)?>(nil)
    static let failNextChild = Mutex(false)
    static let heldChild = Mutex<(@Sendable () -> Void)?>(nil)
    static let holdChildren = Mutex(false)
    static let paths = Mutex<[String]>([])
    static let observer = Mutex<AsyncStream<String>.Continuation?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let path = request.url!.path
        Self.paths.withLock { $0.append(path) }
        let body: Data
        if path == "/api/v1/activity/groups" {
            body = Self.groupBody
        } else if path == "/api/v1/activity/groupChildren" {
            let cursor = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "cursor" }?.value
            body = Self.children(secondPage: cursor != nil)
        } else {
            body = Self.empty
        }
        if path == "/api/v1/activity/groupChildren",
            Self.failNextChild.withLock({ flag in
                let fail = flag
                flag = false
                return fail
            })
        {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        if path == "/api/v1/activity/groupChildren", Self.holdChildren.withLock({ $0 }) {
            let completion: @Sendable () -> Void = { self.finish(body: body) }
            Self.heldChild.withLock { $0 = completion }
            Self.observer.withLock { $0 }?.yield(path)
            return
        }
        Self.observer.withLock { $0 }?.yield(path)
        finish(body: body)
    }

    func finish(body: Data) {
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
        row["state"] = Self.settled.withLock { $0 } ? "completed" : "running"
        row["active"] = !Self.settled.withLock { $0 }
        return try! JSONSerialization.data(withJSONObject: [
            "items": [row], "total": 2,
            "nextCursor": secondPage ? NSNull() : "child-page-2",
        ])
    }

    static var groupBody: Data {
        guard Self.settled.withLock({ $0 }) else { return Self.groups }
        var body = try! JSONSerialization.jsonObject(with: Self.groups) as! [String: Any]
        var items = body["items"] as! [[String: Any]]
        items[0]["active"] = false
        items[0]["workSummary"] = "3 completed"
        items[0]["childCount"] = 2
        items[0]["workCounts"] = [
            "working": 0, "waiting": 0, "needsReview": 0, "failed": 0, "completed": 3, "skipped": 0,
        ]
        body["totalItems"] = 3
        body["items"] = items
        return try! JSONSerialization.data(withJSONObject: body)
    }

    static let empty = Data(#"{"items":[],"total":0,"nextCursor":null}"#.utf8)
    static let groups = Data(
        #"{"items":[{"root":{"id":"RUN-4K7M","recordType":"run","parentRunId":null,"kind":"mail_discovery","trigger":null,"vendorAccountId":null,"vendorId":null,"ledgerPartyId":null,"subjectId":null,"subjectName":"Sample discovery","iconEntity":"run","dataQuality":null,"subjectImage":null,"workLabel":"Mail discovery","currentStep":null,"targetCounts":null,"targetSummary":null,"targetPreview":[],"changedCount":0,"state":"completed","active":false,"createdAt":"2026-01-01T00:00:00Z","completedAt":"2026-01-01T00:00:01Z","durationMs":1000,"attempts":1,"executors":[],"estimatedCost":null,"error":null,"hasDiagnostics":false,"canRetry":false},"active":true,"workCounts":{"working":1,"waiting":0,"needsReview":0,"failed":0,"completed":1,"skipped":0},"workSummary":"1 working · 1 completed","childCount":1,"contextOnly":false,"latestAt":"2026-01-01T00:00:02Z"}],"total":1,"totalItems":2,"nextCursor":null}"#
            .utf8)
}

@MainActor
@Suite("Activity grouped list", .serialized)
struct ActivityListModelTests {
    @Test func settlementRefreshSurvivesConcurrentChildPagination() async throws {
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
        model.expandedRoots.insert("RUN-4K7M")
        await model.loadChildren(rootID: "RUN-4K7M", client: client)
        let (requests, continuation) = AsyncStream<String>.makeStream()
        ActivityListStub.observer.withLock { $0 = continuation }
        ActivityListStub.settled.withLock { $0 = true }
        ActivityListStub.holdGroups.withLock { $0 = true }
        var iterator = requests.makeAsyncIterator()
        let refresh = Task { await model.refreshLoaded(client: client) }
        #expect(await iterator.next() == "/api/v1/activity/groups")
        ActivityListStub.holdChildren.withLock { $0 = true }
        let more = Task { await model.loadChildren(rootID: "RUN-4K7M", client: client, reset: false) }
        #expect(await iterator.next() == "/api/v1/activity/groupChildren")
        ActivityListStub.holdGroups.withLock { $0 = false }
        ActivityListStub.heldGroup.withLock { $0 }?()
        await refresh.value
        ActivityListStub.holdChildren.withLock { $0 = false }
        ActivityListStub.heldChild.withLock { $0 }?()
        await more.value
        #expect(model.groups?.items.first?.active == false)
        #expect(model.children["RUN-4K7M"]?.items.first?.active == true)
        let poll = Task { await model.pollActive(client: client) }
        let deadline = Task {
            try? await Task.sleep(for: .seconds(2))
            continuation.finish()
        }
        defer {
            refresh.cancel()
            more.cancel()
            poll.cancel()
            deadline.cancel()
            continuation.finish()
            ActivityListStub.observer.withLock { $0 = nil }
            ActivityListStub.settled.withLock { $0 = false }
            ActivityListStub.holdGroups.withLock { $0 = false }
            ActivityListStub.holdChildren.withLock { $0 = false }
            ActivityListStub.heldGroup.withLock { $0 = nil }
            ActivityListStub.heldChild.withLock { $0 = nil }
        }
        #expect(await iterator.next() == "/api/v1/activity/groups")
        #expect(await iterator.next() == "/api/v1/activity/groupChildren")
        #expect(await iterator.next() == "/api/v1/activity/groupChildren")
        let settlementDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while model.children["RUN-4K7M"]?.items.allSatisfy({ !$0.active }) != true,
            ContinuousClock.now < settlementDeadline
        {
            await Task.yield()
        }
        poll.cancel()
        await poll.value
        #expect(model.children["RUN-4K7M"]?.items.allSatisfy { !$0.active } == true)
    }

    @Test func parentPaginationKeepsAnExpandedChildRequestAlive() async throws {
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
        model.expandedRoots.insert("RUN-4K7M")
        let (requests, continuation) = AsyncStream<String>.makeStream()
        ActivityListStub.observer.withLock { $0 = continuation }
        ActivityListStub.holdChildren.withLock { $0 = true }
        let child = Task { await model.loadChildren(rootID: "RUN-4K7M", client: client) }
        defer {
            child.cancel()
            continuation.finish()
            ActivityListStub.observer.withLock { $0 = nil }
            ActivityListStub.holdChildren.withLock { $0 = false }
            ActivityListStub.heldChild.withLock { $0 = nil }
        }
        var iterator = requests.makeAsyncIterator()
        #expect(await iterator.next() == "/api/v1/activity/groupChildren")
        await model.load(client: client, reset: false)
        #expect(model.childLoading["RUN-4K7M"] != nil)
        ActivityListStub.heldChild.withLock { $0 }?()
        await child.value
        #expect(model.children["RUN-4K7M"]?.items.map(\.id) == ["RUN-4K7N"])
    }

    @Test func retryingChildRefreshPreservesLoadedDepth() async throws {
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
        await model.loadChildren(rootID: "RUN-4K7M", client: client, reset: false)
        ActivityListStub.failNextChild.withLock { $0 = true }
        await model.loadChildren(rootID: "RUN-4K7M", client: client)
        #expect(model.childErrors["RUN-4K7M"] != nil)
        #expect(model.children["RUN-4K7M"]?.items.count == 2)
        await model.loadChildren(rootID: "RUN-4K7M", client: client)
        #expect(model.childErrors["RUN-4K7M"] == nil)
        #expect(model.children["RUN-4K7M"]?.items.map(\.id) == ["RUN-4K7N", "RUN-4K7P"])
    }

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
