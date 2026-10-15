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

    /// The gate's 426 arrives on whichever request the app happens to make first, so the trace
    /// (which every request reports to) latches it for the root view.
    @Test func latchesAnUpdateRequiredResponse() async {
        let trace = await RequestTrace()
        await trace.record(operationID: "a", ms: 1, status: 200)
        #expect(await trace.clientUpdateRequired == false)
        await trace.record(operationID: "b", ms: 1, status: 426)
        await trace.record(operationID: "c", ms: 1, status: 200)
        #expect(await trace.clientUpdateRequired)
    }
}
