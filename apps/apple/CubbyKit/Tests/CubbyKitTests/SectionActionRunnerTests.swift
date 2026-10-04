import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class RunnerStub: URLProtocol, @unchecked Sendable {
    static let handler = Mutex<StubNetworking.Handler?>(nil)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        StubNetworking.startLoading(
            request, client: client, target: self, handler: Self.handler.withLock { $0 })
    }
    override func stopLoading() {}
    static func session() -> URLSession { StubNetworking.session(protocolClass: self) }
}

/// The native side of the finance report verbs: a verb runs the same operation web's handler
/// calls, only when the server offers it, and never with a row the server refused. Synthetic ids.
@Suite("Report records and section verbs", .serialized)
struct SectionActionRunnerTests {
    private struct Seen: Sendable {
        let method: String?
        let path: String
        let body: [String: JSONValue]
    }

    private final class Recorder: Sendable {
        let seen = Mutex<[Seen]>([])
        var requests: [Seen] { seen.withLock { $0 } }
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: RunnerStub.session())
    }

    private func respond(_ answer: @escaping @Sendable (Seen) -> (Int, Data)) -> Recorder {
        let recorder = Recorder()
        RunnerStub.handler.withLock { handler in
            handler = { request in
                let data = (try? Self.requestBody(request)) ?? Data()
                let seen = Seen(
                    method: request.httpMethod, path: request.url?.path ?? "",
                    body: (try? JSONDecoder().decode([String: JSONValue].self, from: data)) ?? [:])
                recorder.seen.withLock { $0.append(seen) }
                return answer(seen)
            }
        }
        return recorder
    }

    nonisolated private static func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return data
    }

    // MARK: - Fixtures

    /// Two charges that can be checked, one the server refuses, and the search verb.
    nonisolated private static func chargeSearch(
        searchReason: String? = nil, firstChargeReason: String? = nil
    ) -> String {
        let reason = searchReason.map { "\"\($0)\"" } ?? "null"
        let first = firstChargeReason.map { "\"\($0)\"" } ?? "null"
        return """
            {"blocks":[{"kind":"records","empty":"","actions":[],"rows":[
              {"entity":null,"id":null,"title":"Example Hardware · 2026-03-03","subtitle":null,
               "trailing":"$42.50","key":"FTX-4K7M","disabledReason":\(first)},
              {"entity":"run","id":"RUN-4K7M","title":"Example Garden · 2026-03-04",
               "subtitle":"A search is already running for this charge.","trailing":"$12.00",
               "badges":["Searching"],"key":"FTX-5N8P",
               "disabledReason":"A search is already running for this charge."},
              {"entity":null,"id":null,"title":"Example Lumber · 2026-03-05","subtitle":null,
               "trailing":"$7.25","key":"FTX-6Q9R","disabledReason":null}
            ],"verbs":[{"id":"searchCharges","label":"Search selected charges","scope":"selection",
              "disabledReason":\(reason)}]}]}
            """
    }

    private func records(_ json: String) throws -> ReportPresentation.Records {
        let report = try JSONDecoder().decode(EntityReportOut.self, from: Data(json.utf8))
        for block in ReportPresentation(report).blocks {
            if case .records(let records) = block { return records }
        }
        throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "no records block"))
    }

    // MARK: - Rows

    @Test func readsTheServersWordsAndAmountsAsGiven() throws {
        let records = try records(Self.chargeSearch())
        #expect(records.rows.compactMap(\.key) == ["FTX-4K7M", "FTX-5N8P", "FTX-6Q9R"])
        #expect(records.rows[0].trailing == "$42.50")
        #expect(records.rows[1].entity == .run)
        #expect(records.rows[1].recordID == "RUN-4K7M")
        #expect(records.verb(.searchCharges)?.actsOnSelection == true)
    }

    @Test func neverChecksARowTheServerRefused() throws {
        let records = try records(Self.chargeSearch())
        #expect(records.toggled([], "FTX-5N8P").isEmpty)
        #expect(records.toggled([], "FTX-4K7M") == ["FTX-4K7M"])
        #expect(records.toggled(["FTX-4K7M"], "FTX-4K7M").isEmpty)
    }

    @Test func aFreshReadDropsACheckedRowTheServerNowRefuses() throws {
        let fresh = try records(Self.chargeSearch(firstChargeReason: "Claimed by a run."))
        #expect(fresh.allowed(["FTX-4K7M", "FTX-6Q9R"]) == ["FTX-6Q9R"])
    }

    // MARK: - searchCharges

    @Test @MainActor func startsOneRunForExactlyTheCheckedChargesInListedOrder() async throws {
        let recorder = respond { _ in (200, Data("{\"runId\":\"RUN-5N8P\"}".utf8)) }
        let run = try await SectionActionRunner(client: makeClient()).searchCharges(
            vendorAccountID: "VACCT-4K7M", records: records(Self.chargeSearch()),
            selection: ["FTX-6Q9R", "FTX-4K7M"])

        #expect(run == "RUN-5N8P")
        let start = try #require(recorder.requests.last)
        #expect(start.method == "POST")
        #expect(start.path == "/api/v1/vendor/startChargeRun")
        #expect(
            start.body == [
                "vendorAccountId": "VACCT-4K7M",
                "transactionIds": ["FTX-4K7M", "FTX-6Q9R"],
            ])
    }

    @Test @MainActor func sendsNothingWhenNothingIsChecked() async throws {
        let recorder = respond { _ in (200, Data()) }
        await #expect(throws: SectionActionError.nothingSelected) {
            _ = try await SectionActionRunner(client: self.makeClient()).searchCharges(
                vendorAccountID: "VACCT-4K7M", records: self.records(Self.chargeSearch()), selection: [])
        }
        #expect(recorder.requests.isEmpty)
    }

    @Test @MainActor func refusesARefusedRowEvenIfAskedToDirectly() async throws {
        let recorder = respond { _ in (200, Data()) }
        await #expect(
            throws: SectionActionError.refusedSelection("A search is already running for this charge.")
        ) {
            _ = try await SectionActionRunner(client: self.makeClient()).searchCharges(
                vendorAccountID: "VACCT-4K7M", records: self.records(Self.chargeSearch()),
                selection: ["FTX-4K7M", "FTX-5N8P"])
        }
        #expect(recorder.requests.isEmpty)
    }

    @Test @MainActor func refusesWhenTheServerLeavesTheVerbUnavailable() async throws {
        let recorder = respond { _ in (200, Data()) }
        await #expect(throws: SectionActionError.unavailable("Another search is running.")) {
            _ = try await SectionActionRunner(client: self.makeClient()).searchCharges(
                vendorAccountID: "VACCT-4K7M",
                records: self.records(Self.chargeSearch(searchReason: "Another search is running.")),
                selection: ["FTX-4K7M"])
        }
        #expect(recorder.requests.isEmpty)
    }

    // MARK: - Coverage

    @Test func classifiesEverySectionVerb() throws {
        let coverage = NativeCoverageManifest.shared.sectionAction
        #expect(Set(coverage.keys) == Set(SectionActionID.allCases.map(\.rawValue)))
        #expect(SectionActionRunner.coverage(of: .searchCharges) == .implemented)
        #expect(SectionActionRunner.coverage(of: .matchStatement) == .implemented)
        #expect(SectionActionRunner.coverage(of: .receiveExpense) == .implemented)
        // Splitting and attaching change what an order covers; web alone does them.
        for verb in [SectionActionID.splitExpense, .linkExpenses, .linkProducts] {
            #expect(SectionActionRunner.coverage(of: verb).isUnsupported)
        }
    }

    @Test func refusesAnUnsupportedVerbWithItsReason() throws {
        let records = try records(
            """
            {"blocks":[{"kind":"records","rows":[],"empty":"No purchase recorded.","actions":[],"verbs":[
              {"id":"splitExpense","label":"Split","scope":"section","disabledReason":null}]}]}
            """)
        #expect(throws: SectionActionError.unsupported("Splitting an expense into parts is edited on web.")) {
            try SectionActionRunner.canOpen(.splitExpense, in: records)
        }
    }
}
