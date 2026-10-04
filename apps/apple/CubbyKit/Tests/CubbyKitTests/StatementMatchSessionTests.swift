import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class MatchStub: URLProtocol, @unchecked Sendable {
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

/// "Match statement activity" on native. The rules under test are the ones that keep native from
/// settling anything web would not: a suggestion never selects or writes, the server decides
/// whether typed rows can be saved, and a save writes only what the server returned. Synthetic
/// ids and amounts.
@Suite("StatementMatchSession", .serialized)
struct StatementMatchSessionTests {
    private struct Seen: Sendable {
        let method: String?
        let path: String
        let query: String
        let body: JSONValue
    }

    private final class Recorder: Sendable {
        let seen = Mutex<[Seen]>([])
        var requests: [Seen] { seen.withLock { $0 } }
        func writes() -> [Seen] { requests.filter { $0.method == "PATCH" } }
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: MatchStub.session())
    }

    /// Routes by path; anything unrouted is a 500 so an unexpected call fails loudly.
    private func serve(_ routes: [String: @Sendable (Seen) -> String]) -> Recorder {
        let recorder = Recorder()
        MatchStub.handler.withLock { handler in
            handler = { request in
                let data = (try? Self.requestBody(request)) ?? Data()
                let seen = Seen(
                    method: request.httpMethod, path: request.url?.path ?? "",
                    query: request.url?.query ?? "",
                    body: (try? JSONDecoder().decode(JSONValue.self, from: data)) ?? .null)
                recorder.seen.withLock { $0.append(seen) }
                guard let route = routes[seen.path] else { return (500, Data()) }
                return (200, Data(route(seen).utf8))
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

    nonisolated private static func transaction(_ id: String, amount: Double, merchant: String) -> String {
        """
        {"bookingCoverage":"missing","documentCoverage":"missing","itemizationCoverage":"missing",
         "productsCoverage":"missing","coverage":{"expectation":"unknown","booking":"missing",
         "document":"missing","itemization":"missing","products":"missing"},
         "spendingCategorySummary":{"state":"unclassified","categories":[],"lineCount":0,
         "categorizedLineCount":0,"uncategorizedLineCount":0,"complete":false,"amountsKnown":false},
         "spendingCategoryId":null,"spendingCategoryName":null,"evidenceExpectation":null,"id":"\(id)",
         "accountId":"FAC-4K7M","purchaseId":null,"kind":"purchase","status":"posted","amount":\(amount),
         "transactionDate":"2026-03-03","postedDate":"2026-03-04","merchant":"\(merchant)",
         "rawDescription":null,"sourceCategory":null,"sourceRefs":[],"notes":null,"allocations":[],
         "ledgerTransferId":null,"accountName":"Example Card","itemization":"bare","vendorInference":null,
         "displayName":"\(merchant)","createdAt":"2026-03-04T12:00:00.000Z","updatedAt":"2026-03-04T12:00:00.000Z",
         "dataQuality":{"status":"complete","score":100,"facets":[],"gaps":[],"exceptions":[],
         "relatedGaps":[],"relatedExceptions":[]}}
        """
    }

    nonisolated private static func candidate(
        _ id: String, amount: Double, merchant: String, proposed: String
    ) -> String {
        """
        {"transaction":\(transaction(id, amount: amount, merchant: merchant)),"days":2,
         "merchantMatches":true,"exactAmount":true,"title":"\(merchant)",
         "lines":["Charge","2026-03-04 · 2 days apart · vendor name matches"],
         "proposedAllocations":\(proposed)}
        """
    }

    /// Two tied candidates and a lower-ranked third.
    nonisolated private static let candidatesJSON = """
        {"advisory":true,"message":null,"candidates":[
          \(candidate("FTX-4K7M", amount: 91, merchant: "Example Hardware North",
                      proposed: "[{\"purchaseId\":\"PUR-2345\",\"amount\":\"42.50\"},{\"purchaseId\":\"\",\"amount\":\"48.50\"}]")),
          \(candidate("FTX-5N8P", amount: 42.5, merchant: "Example Hardware South",
                      proposed: "[{\"purchaseId\":\"PUR-2345\",\"amount\":\"42.50\"}]")),
          \(candidate("FTX-6Q9R", amount: 42.5, merchant: "Example Garden",
                      proposed: "[{\"purchaseId\":\"PUR-2345\",\"amount\":\"42.50\"}]"))
        ],"tiedTransactionIds":["FTX-4K7M","FTX-5N8P"],
        "suggestHint":"2 charges rank equally. Jev can suggest which fits best; you still choose and allocate."}
        """

    nonisolated private static let rankedJSON = """
        {"status":"ranked","advisory":true,"selectedTransactionId":"FTX-5N8P",
         "ranked":[{"transactionId":"FTX-5N8P","probability":0.72,"badge":"Suggested · 72%"},
                   {"transactionId":"FTX-4K7M","probability":0.18,"badge":"18%"}],
         "displayOrder":["FTX-5N8P","FTX-4K7M","FTX-6Q9R"],
         "note":"Suggestion only. Jev ordered the 2 equally ranked charges; nothing is saved until you allocate."}
        """

    nonisolated private static func check(
        allocations: String, total: Double, remaining: Double, reason: String?
    )
        -> String
    {
        let reason = reason.map { "\"\($0)\"" } ?? "null"
        return """
            {"allocations":\(allocations),"allocatedTotal":\(total),"remaining":\(remaining),"reason":\(reason)}
            """
    }

    @MainActor
    private func loaded(_ recorderRoutes: [String: @Sendable (Seen) -> String]) async throws
        -> (StatementMatchSession, Recorder)
    {
        var routes = recorderRoutes
        routes["/api/v1/purchase/settlementCandidates"] = { _ in Self.candidatesJSON }
        let recorder = serve(routes)
        let session = StatementMatchSession(purchaseID: "PUR-2345", client: try makeClient())
        await session.load()
        return (session, recorder)
    }

    // MARK: - Tests

    @Test @MainActor func startsAnAllocationFromTheServersProposalAndSavesNothing() async throws {
        let (session, recorder) = try await loaded([:])
        #expect(session.displayOrder == ["FTX-4K7M", "FTX-5N8P", "FTX-6Q9R"])
        session.select("FTX-4K7M")
        #expect(session.selectedTransactionID == "FTX-4K7M")
        #expect(session.rows.map(\.purchaseID) == ["PUR-2345", ""])
        #expect(session.rows.map(\.amount) == ["42.50", "48.50"])
        #expect(!session.canSave)
        #expect(recorder.writes().isEmpty)
    }

    @Test @MainActor func aSuggestionOrdersAndBadgesButNeverSelectsOrWrites() async throws {
        let (session, recorder) = try await loaded([
            "/api/v1/purchase/suggestSettlementMatch": { _ in Self.rankedJSON }
        ])
        #expect(
            session.suggestionNote
                == "2 charges rank equally. Jev can suggest which fits best; you still choose and allocate.")
        await session.suggest()
        #expect(session.displayOrder == ["FTX-5N8P", "FTX-4K7M", "FTX-6Q9R"])
        #expect(session.badge(for: "FTX-5N8P") == "Suggested · 72%")
        #expect(session.badge(for: "FTX-6Q9R") == nil)
        #expect(session.suggestionNote?.hasPrefix("Suggestion only.") == true)
        // The pick is shown, not applied.
        #expect(session.selectedTransactionID == nil)
        #expect(session.rows.isEmpty)
        #expect(recorder.writes().isEmpty)
        #expect(
            recorder.requests.map(\.path)
                == ["/api/v1/purchase/settlementCandidates", "/api/v1/purchase/suggestSettlementMatch"])
    }

    @Test @MainActor func showsTheRawDiagnosticWhenASuggestionIsUnavailable() async throws {
        let (session, _) = try await loaded([
            "/api/v1/purchase/suggestSettlementMatch": { _ in
                """
                {"status":"unavailable","error":"gateway timeout","note":"Suggestion unavailable: gateway timeout"}
                """
            }
        ])
        await session.suggest()
        #expect(session.suggestionNote == "Suggestion unavailable: gateway timeout")
        #expect(session.displayOrder == ["FTX-4K7M", "FTX-5N8P", "FTX-6Q9R"])
    }

    @Test @MainActor func asksTheServerAboutExactlyTheRowsTyped() async throws {
        let (session, recorder) = try await loaded([
            "/api/v1/purchase/checkSettlementAllocation": { _ in
                Self.check(
                    allocations: "null", total: 42.5, remaining: 48.5,
                    reason: "Row 2: enter a Purchase code such as PUR-4K7M.")
            }
        ])
        session.select("FTX-4K7M")
        await session.recheck()
        #expect(session.check?.reason == "Row 2: enter a Purchase code such as PUR-4K7M.")
        #expect(!session.canSave)
        let ask = try #require(recorder.requests.last)
        #expect(ask.path == "/api/v1/purchase/checkSettlementAllocation")
        #expect(
            ask.body
                == [
                    "transactionId": "FTX-4K7M",
                    "allocations": [
                        ["purchaseId": "PUR-2345", "amount": "42.50"],
                        ["purchaseId": "", "amount": "48.50"],
                    ],
                ])
    }

    @Test @MainActor func savesOnlyWhatTheServerReturnsAsTheTransactionsOwnUpdate() async throws {
        let (session, recorder) = try await loaded([
            "/api/v1/purchase/checkSettlementAllocation": { _ in
                Self.check(
                    allocations:
                        "[{\"purchaseId\":\"PUR-2345\",\"amount\":42.5},{\"purchaseId\":\"PUR-3456\",\"amount\":48.5}]",
                    total: 91, remaining: 0, reason: nil)
            },
            "/api/v1/financial-transactions/FTX-4K7M": { _ in
                """
                {"action":"update","entity":"financialTransaction","item":\(Self.transaction("FTX-4K7M", amount: 91, merchant: "Example Hardware North")),"sideEffects":{}}
                """
            },
        ])
        session.select("FTX-4K7M")
        session.setPurchaseID("PUR-3456", for: session.rows[1].id)
        await session.recheck()
        #expect(session.canSave)

        try await session.save()

        let write = try #require(recorder.writes().first)
        #expect(write.path == "/api/v1/financial-transactions/FTX-4K7M")
        // The typed strings are not what is sent: the server's validated numbers are.
        #expect(
            write.body
                == [
                    "allocations": [
                        ["purchaseId": "PUR-2345", "amount": 42.5],
                        ["purchaseId": "PUR-3456", "amount": 48.5],
                    ]
                ])
        #expect(session.didSave)
    }

    @Test @MainActor func aRefusedCheckSendsNoWrite() async throws {
        let (session, recorder) = try await loaded([
            "/api/v1/purchase/checkSettlementAllocation": { _ in
                Self.check(
                    allocations: "null", total: 42.5, remaining: 48.5,
                    reason: "Allocations total $42.50, not $91.00.")
            }
        ])
        session.select("FTX-4K7M")
        await #expect(throws: StatementMatchSession.Failure.refused("Allocations total $42.50, not $91.00."))
        {
            try await session.save()
        }
        #expect(recorder.writes().isEmpty)
        #expect(!session.didSave)
    }

    @Test @MainActor func cannotSaveBeforeAnEntryIsChosen() async throws {
        let (session, recorder) = try await loaded([:])
        await #expect(throws: StatementMatchSession.Failure.nothingSelected) {
            try await session.save()
        }
        #expect(recorder.writes().isEmpty)
    }
}
