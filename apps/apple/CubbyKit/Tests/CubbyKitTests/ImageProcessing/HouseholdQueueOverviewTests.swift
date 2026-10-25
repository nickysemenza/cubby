import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class ActivityQueueStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
}

@Suite("Activity entity lists", .serialized)
@MainActor
struct HouseholdQueueOverviewTests {
    @Test func chipsAndRetryUseTheSameManifestFiltersAndAttentionIsBounded() async throws {
        let requests = Mutex<[(String, JSONValue)]>([])
        ActivityQueueStub.handler.withLock { handler in
            handler = { request in
                let operation = request.url?.lastPathComponent ?? ""
                let input = StubNetworking.operationInput(of: request) ?? .null
                requests.withLock { $0.append((operation, input)) }
                let payload: String
                switch operation {
                case "job.queue":
                    payload =
                        #"{"counts":[{"lane":"server","reason":"due","count":3}],"total":3,"leases":[],"jobs":[]}"#
                case "job.health": payload = #"{"snapshot":null}"#
                case "job.retryNow": payload = #"{"retried":1}"#
                case "entity.listBase":
                    let entity = input["entity"]?.stringValue ?? "job"
                    payload = """
                        {"entity":"\(entity)","data":[],"groups":[],"meta":{"pageIndex":0,"pageSize":10,"totalCount":0}}
                        """
                case "entity.listSummary":
                    payload = #"{"entity":"job","sums":{},"totalLabels":{}}"#
                default: payload = #"{"items":[],"meta":{"pageIndex":0,"pageSize":10,"totalCount":0}}"#
                }
                return (200, Data(payload.utf8))
            }
        }
        defer { ActivityQueueStub.handler.withLock { $0 = nil } }
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("synthetic-token"), for: "example.test")
        let client = CubbyClient(
            baseURL: URL(string: "https://example.test")!,
            credentials: CredentialProvider(host: "example.test", store: store),
            session: StubNetworking.session(protocolClass: ActivityQueueStub.self))
        let model = HouseholdQueueOverview(client: client)
        await model.refresh()
        #expect(model.counts.first?.lane == .server)
        let queueRead = try #require(requests.withLock { $0.first { $0.0 == "job.queue" } })
        #expect(queueRead.1["filter"]?["entityFilters"] == .object([:]))
        let runRead = try #require(
            requests.withLock { $0.first { $0.0 == "entity.listBase" && $0.1["entity"] == "run" } })
        #expect(runRead.1["pagination"]?["pageSize"] == 10)
        #expect(runRead.1["filters"]?["needsAttention"] == true)
        #expect(runRead.1["sort"]?.arrayValue?.first?["orderBy"] == "stalled")
        await model.filter(lane: "apple_device", reason: "waiting_device")
        await model.retry()
        let retry = try #require(requests.withLock { $0.last { $0.0 == "job.retryNow" } })
        #expect(retry.1["filter"]?["entityFilters"]?["lane"] == ["apple_device"])
        #expect(retry.1["filter"]?["entityFilters"]?["reason"] == ["waiting_device"])
        #expect(model.error == nil)
    }
}
