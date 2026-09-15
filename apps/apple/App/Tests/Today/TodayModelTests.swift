import CubbyKit
import Foundation
import Observation
import Synchronization
import Testing

@testable import Cubby

nonisolated private final class TodayModelStub: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest, TodayModelStub) -> Void
    static let handler = Mutex<Handler?>(nil)

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
        defer { TodayModelStub.handler.withLock { $0 = nil } }
        let (pendingRequests, pendingContinuation) = AsyncStream<TodayModelStub>.makeStream()
        TodayModelStub.handler.withLock { handler in
            handler = { request, stub in
                switch request.url!.path() {
                case "/api/v1/task/todayBriefing":
                    stub.respond(status: 200, data: Self.tasksPayload)
                default:
                    pendingContinuation.yield(stub)
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
        firstPending.respond(status: 500, data: Self.failurePayload)
        secondPending.respond(status: 500, data: Self.failurePayload)
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
        #"{"next":[{"id":"TSK-2345","name":"Water seedlings","status":"not_started","dueDate":null,"dueEndDate":null,"projectId":null,"projectName":null}],"nextCount":1,"laterCount":0,"blockedCount":0,"overdueCount":0,"dueThisWeekCount":0}"#
            .utf8
    )
    nonisolated private static let failurePayload = Data(
        #"{"code":"TEST","message":"Still offline"}"#.utf8)

    private static func loadedTaskName(_ state: TodaySectionState<[TodayTask]>) -> String? {
        guard case .loaded(let tasks) = state else { return nil }
        return tasks.first?.name
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
