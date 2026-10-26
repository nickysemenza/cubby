import CubbyKit
import Foundation
import Observation
import Synchronization
import Testing

@testable import Cubby

nonisolated private final class TodayModelStub: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest, TodayModelStub) -> Void
    static let handler = Mutex<Handler?>(nil)
    // URLProtocol is Foundation-owned and remains alive until the test completes the response.
    // Each token is removed under the mutex before its one response, and this fixture never
    // cancels a deferred request. No protocol reference crosses the AsyncStream boundary.
    private struct PendingResponse: @unchecked Sendable {
        let stub: TodayModelStub
    }
    private static let pending = Mutex<[UUID: PendingResponse]>([:])

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = Self.handler.withLock({ $0 }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        handler(request, self)
    }
    override func stopLoading() {}

    func respond(status: Int, data: Data) {
        var responseData = data
        if request.url?.path.hasPrefix("/api/operations/") == true,
            (200..<300).contains(status)
        {
            let payload =
                (try? JSONSerialization.jsonObject(
                    with: data, options: [.fragmentsAllowed])) ?? NSNull()
            responseData =
                (try? JSONSerialization.data(
                    withJSONObject: ["ok": true, "data": payload], options: [.fragmentsAllowed])) ?? data
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: responseData)
        client?.urlProtocolDidFinishLoading(self)
    }

    static func deferResponse(for stub: TodayModelStub) -> UUID {
        let token = UUID()
        pending.withLock { $0[token] = PendingResponse(stub: stub) }
        return token
    }

    static func respond(to token: UUID, status: Int, data: Data) {
        let stub = pending.withLock { $0.removeValue(forKey: token) }
        stub?.stub.respond(status: status, data: data)
    }

    static func clearPendingResponses() {
        pending.withLock { $0.removeAll() }
    }

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [self]
        return URLSession(configuration: configuration)
    }
}

@MainActor
@Suite("TodayModel", .serialized)
struct TodayModelTests {
    @Test(.timeLimit(.minutes(1)))
    func eachSectionPublishesWhenItsOwnRequestCompletes() async throws {
        defer {
            TodayModelStub.handler.withLock { $0 = nil }
            TodayModelStub.clearPendingResponses()
        }
        let (pendingRequests, pendingContinuation) = AsyncStream<UUID>.makeStream()
        TodayModelStub.handler.withLock { handler in
            handler = { request, stub in
                switch request.url!.path() {
                case "/api/operations/entityReport.get":
                    stub.respond(status: 200, data: Self.tasksPayload)
                default:
                    pendingContinuation.yield(TodayModelStub.deferResponse(for: stub))
                }
            }
        }
        let model = TodayModel(client: try makeClient())
        let refresh = Task { await model.refresh() }
        var pendingIterator = pendingRequests.makeAsyncIterator()
        let firstPendingValue = await pendingIterator.next()
        let firstPending = try #require(firstPendingValue)

        await waitUntil { Self.loadedTaskName(model.tasks) == "Water seedlings" }
        #expect(model.mealsIsLoading)
        #expect(Self.loadedTaskName(model.tasks) == "Water seedlings")
        if case .loaded(let briefing) = model.tasks {
            let figures = ReportPresentation(briefing).blocks.flatMap {
                block -> [ReportPresentation.Figure] in
                if case .stats(_, let figures) = block { return figures }
                return []
            }
            #expect(figures.first { $0.label == "Due this week" }?.value == 1)
            #expect(figures.first { $0.label == "Later" }?.value == 2)
        }
        TodayModelStub.respond(to: firstPending, status: 500, data: Self.failurePayload)
        pendingContinuation.finish()
        await refresh.value
    }

    @Test(.timeLimit(.minutes(1)))
    func refreshFailureRetainsThePreviouslyLoadedSection() async throws {
        defer { TodayModelStub.handler.withLock { $0 = nil } }
        let shouldFail = Mutex(false)
        TodayModelStub.handler.withLock { handler in
            handler = { request, stub in
                guard request.url!.path() == "/api/operations/entityReport.get" else {
                    stub.respond(status: 500, data: Self.failurePayload)
                    return
                }
                if shouldFail.withLock({ $0 }) {
                    stub.respond(status: 503, data: Self.failurePayload)
                } else {
                    stub.respond(status: 200, data: Self.tasksPayload)
                }
            }
        }
        let model = TodayModel(client: try makeClient())

        await model.refreshTasks()
        shouldFail.withLock { $0 = true }
        await model.refreshTasks()

        #expect(Self.loadedTaskName(model.tasks) == "Water seedlings")
        #expect(model.tasksError == "TEST: Still offline")
        #expect(model.tasksIsLoading == false)
    }

    @Test
    func todayReadingOrderLeadsWithTasks() {
        #expect(TodaySection.allCases == [.tasks, .activity, .meals, .nutrition, .changes, .views])
    }

    @Test
    func taskRowsLeadAndOnlyUsefulStatsRemain() throws {
        let report = try JSONDecoder().decode(EntityReportOut.self, from: Self.tasksPayload)
        let presentation = TodayBriefingPresentation(report)
        #expect(presentation.moreReady == ["2 more ready"])
        guard case .records(let records) = try #require(presentation.tasks.blocks.first) else {
            Issue.record("Expected task rows first")
            return
        }
        #expect(records.footer == nil)
        #expect(records.rows.first?.trailing != "2026-10-25")
        #expect(Self.loadedTaskName(.loaded(presentation.tasks)) == "Water seedlings")
        let stats = ReportPresentation(presentation.stats).blocks
        guard case .stats(_, let figures) = try #require(stats.first) else {
            Issue.record("Expected summary figures")
            return
        }
        #expect(figures.map(\.label) == ["Due this week"])
        #expect(!presentation.tasks.blocks.contains { if case .stats = $0 { true } else { false } })
    }

    @Test
    func allFailedKeepsOneRawDiagnosticAndPartialSuccessStaysVisible() async throws {
        defer { TodayModelStub.handler.withLock { $0 = nil } }
        TodayModelStub.handler.withLock { handler in
            handler = { _, stub in stub.respond(status: 503, data: Self.failurePayload) }
        }
        let model = TodayModel(client: try makeClient())
        await model.refresh()
        #expect(
            TodayModel.failureMessage(
                tasks: model.tasks, meals: model.meals,
                nutrition: .failed("TEST: Still offline"), changesError: "TEST: Still offline"
            ) == "TEST: Still offline")
        #expect(
            TodayModel.failureMessage(
                tasks: model.tasks, meals: model.meals,
                nutrition: .failed("NUTRITION: Upstream response"), changesError: "TEST: Still offline"
            ) == "TEST: Still offline\n\nNUTRITION: Upstream response")
        #expect(
            TodayModel.failureMessage(
                tasks: model.tasks, meals: .loaded([]),
                nutrition: .failed("TEST: Still offline"), changesError: "TEST: Still offline"
            ) == nil)
        #expect(
            TodayModel.failureMessage(
                tasks: model.tasks, meals: model.meals,
                nutrition: .loading, changesError: "TEST: Still offline"
            ) == nil)
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: TodayModelStub.session()
        )
    }

    nonisolated private static let tasksPayload = Data(
        #"{"blocks":[{"kind":"stats","figures":[{"label":"Due this week","value":1,"format":"count"},{"label":"Later","value":2,"format":"count"}]},{"kind":"records","empty":"No tasks","rows":[{"entity":"task","id":"TSK-2345","title":"Water seedlings","trailing":"2026-10-25"}],"footer":"2 more ready"}]}"#
            .utf8
    )
    nonisolated private static let failurePayload = Data(
        #"{"code":"TEST","message":"Still offline"}"#.utf8)

    private static func loadedTaskName(_ state: TodaySectionState<EntityReportOut>) -> String? {
        guard case .loaded(let tasks) = state else { return nil }
        for block in ReportPresentation(tasks).blocks {
            if case .records(let records) = block { return records.rows.first?.title }
        }
        return nil
    }

    private func waitUntil(_ condition: @MainActor () -> Bool) async {
        while !condition() {
            let (changes, continuation) = AsyncStream<Void>.makeStream()
            withObservationTracking {
                _ = condition()
            } onChange: {
                continuation.yield()
                continuation.finish()
            }
            if condition() {
                continuation.finish()
                return
            }
            for await _ in changes {
                break
            }
        }
    }
}
