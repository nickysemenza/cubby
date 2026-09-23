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
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
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
                case "/api/v1/task/todayBriefing":
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
        let secondPendingValue = await pendingIterator.next()
        let secondPending = try #require(secondPendingValue)

        await waitUntil { Self.loadedTaskName(model.tasks) == "Water seedlings" }
        #expect(model.mealsIsLoading && model.problemsIsLoading)
        #expect(Self.loadedTaskName(model.tasks) == "Water seedlings")
        if case .loaded(let briefing) = model.tasks {
            #expect(briefing.dueThisWeekCount == 1)
            #expect(briefing.laterCount == 2)
        }
        TodayModelStub.respond(to: firstPending, status: 500, data: Self.failurePayload)
        TodayModelStub.respond(to: secondPending, status: 500, data: Self.failurePayload)
        pendingContinuation.finish()
        await refresh.value
    }

    @Test(.timeLimit(.minutes(1)))
    func refreshFailureRetainsThePreviouslyLoadedSection() async throws {
        defer { TodayModelStub.handler.withLock { $0 = nil } }
        let shouldFail = Mutex(false)
        TodayModelStub.handler.withLock { handler in
            handler = { request, stub in
                guard request.url!.path() == "/api/v1/task/todayBriefing" else {
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
        #expect(model.tasksError == "Still offline")
        #expect(model.tasksIsLoading == false)
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
        #"{"next":[{"id":"TSK-2345","name":"Water seedlings","status":"not_started","dueDate":null,"dueEndDate":null,"projectId":null,"projectName":null}],"nextCount":1,"laterCount":2,"blockedCount":0,"overdueCount":0,"dueThisWeekCount":1}"#
            .utf8
    )
    nonisolated private static let failurePayload = Data(
        #"{"code":"TEST","message":"Still offline"}"#.utf8)

    private static func loadedTaskName(_ state: TodaySectionState<TaskTodayBriefingOut>) -> String? {
        guard case .loaded(let tasks) = state else { return nil }
        return tasks.next.first?.name
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
