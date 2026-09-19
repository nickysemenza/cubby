import Testing

@testable import CubbyKit

@Suite("RequestTrace")
struct RequestTraceTests {
    @Test func keepsOnlyTheLast20EntriesAndReportsTheMostRecent() async throws {
        let trace = await RequestTrace()
        for index in 0..<25 {
            await trace.record(operationID: "op-\(index)", ms: Double(index), status: 200)
        }

        let entries = await trace.entries
        #expect(entries.count == RequestTrace.capacity)
        #expect(entries.first?.operationID == "op-5")
        let last = await trace.last
        #expect(last?.operationID == "op-24")
        #expect(last?.status == 200)
    }
}
