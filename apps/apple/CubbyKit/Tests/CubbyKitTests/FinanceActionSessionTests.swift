import Foundation
import Synchronization
import Testing

@testable import CubbyKit

private final class ActionStub: URLProtocol, @unchecked Sendable {
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

/// Split, attach expenses and attach products on native. The rules under test keep native from
/// doing what web would not: the server decides what can be saved, a refused check or a missing
/// confirmation sends no write, and a write carries exactly what the server returned. Synthetic
/// ids and amounts.
@Suite("Finance section actions", .serialized)
struct FinanceActionSessionTests {
    private struct Seen: Sendable {
        let method: String?
        let path: String
        let query: String
        let body: JSONValue
    }

    private final class Recorder: Sendable {
        let seen = Mutex<[Seen]>([])
        var requests: [Seen] { seen.withLock { $0 } }
        func posts(to path: String) -> [Seen] {
            requests.filter { $0.method == "POST" && $0.path == path }
        }
    }

    private func makeClient() throws -> CubbyClient {
        let store = InMemorySessionTokenStore()
        try store.save(.bearer("tok"), for: "localhost:3000")
        return CubbyClient(
            baseURL: URL(string: "http://localhost:3000")!,
            credentials: CredentialProvider(host: "localhost:3000", store: store),
            session: ActionStub.session())
    }

    /// Routes by path; anything unrouted is a 500 so an unexpected call fails loudly.
    private func serve(_ routes: [String: @Sendable (Seen) -> String]) -> Recorder {
        let recorder = Recorder()
        ActionStub.handler.withLock { handler in
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

    // MARK: - Split fixtures

    private static let part = """
        {"name":"%@","cost":"%@","costType":"materials","trade":"other","projectId":"","keepProduct":false,"productQuantity":""}
        """

    nonisolated private static func splitStart(productNote: String? = nil) -> String {
        let note = productNote.map { "\"\($0)\"" } ?? "null"
        let name = productNote == nil ? "null" : "\"Sample saw\""
        return """
            {"title":"Split \\"Sample kit\\"","description":"The parts replace the expense.",
             "confirm":"Splitting replaces this expense with its parts. The original is deleted.",
             "originalCost":0.3,"productName":\(name),"productNote":\(note),"maxParts":100,
             "parts":[
               \(String(format: part, "Sample kit", "0.3")),
               \(String(format: part, "", ""))]}
            """
    }

    /// An accepted check: the exact body to write, with costs that only add up in whole cents.
    nonisolated private static let acceptedSplit = """
        {"split":{"expenseId":"EXP-4K7M","parts":[
           {"name":"Saw","cost":0.1,"costType":"materials","trade":"other","projectId":null,"productId":null,"productQuantity":null},
           {"name":"Blade","cost":0.2,"costType":"materials","trade":"other","projectId":null,"productId":null,"productQuantity":null}]},
         "partsTotal":0.3,"originalCost":0.3,"delta":0,"reason":null,
         "note":"Parts add up to the original cost.","needsAttributionPolicy":false}
        """

    nonisolated private static func refusedSplit(_ reason: String) -> String {
        """
        {"partsTotal":0.31,"originalCost":0.3,"delta":0.01,"reason":"\(reason)",
         "note":"Parts are $0.01 over the original.","needsAttributionPolicy":false}
        """
    }

    nonisolated private static let splitResult = """
        []
        """

    // MARK: - Split

    @Test @MainActor func startsFromTheServersPartsNotOneOfItsOwn() async throws {
        let recorder = serve(["/api/v1/purchase/splitStart": { _ in Self.splitStart() }])
        let session = ExpenseSplitSession(expenseID: "EXP-4K7M", client: try makeClient())
        await session.load()

        #expect(session.parts.map(\.name) == ["Sample kit", ""])
        #expect(session.parts.map(\.cost) == ["0.3", ""])
        #expect(recorder.requests.map(\.path) == ["/api/v1/purchase/splitStart"])
        #expect(recorder.requests[0].query.contains("expenseId=EXP-4K7M"))
    }

    @Test @MainActor func neverWritesWithoutAnExplicitConfirmation() async throws {
        let recorder = serve([
            "/api/v1/purchase/splitStart": { _ in Self.splitStart() },
            "/api/v1/purchase/checkSplit": { _ in Self.acceptedSplit },
            "/api/v1/purchase/split": { _ in Self.splitResult },
        ])
        let session = ExpenseSplitSession(expenseID: "EXP-4K7M", client: try makeClient())
        await session.load()

        await #expect(
            throws: ExpenseSplitSession.Failure.needsConfirmation(
                "Splitting replaces this expense with its parts. The original is deleted.")
        ) {
            _ = try await session.save(confirmed: false)
        }
        #expect(session.confirmation?.contains("deleted") == true)
        #expect(recorder.posts(to: "/api/v1/purchase/split").isEmpty)
        // Not even a check goes out: nothing is asked of the server for an unconfirmed save.
        #expect(recorder.posts(to: "/api/v1/purchase/checkSplit").isEmpty)
    }

    @Test @MainActor func aRefusedCheckSendsNoWrite() async throws {
        let reason = "Split parts must add up to the original cost exactly."
        let recorder = serve([
            "/api/v1/purchase/splitStart": { _ in Self.splitStart() },
            "/api/v1/purchase/checkSplit": { _ in Self.refusedSplit(reason) },
            "/api/v1/purchase/split": { _ in Self.splitResult },
        ])
        let session = ExpenseSplitSession(expenseID: "EXP-4K7M", client: try makeClient())
        await session.load()
        await session.recheck()
        #expect(!session.canSave)

        await #expect(throws: ExpenseSplitSession.Failure.refused(reason)) {
            _ = try await session.save(confirmed: true)
        }
        #expect(recorder.posts(to: "/api/v1/purchase/split").isEmpty)
    }

    @Test @MainActor func writesExactlyTheBodyTheServerReturnedAfterConfirming() async throws {
        let recorder = serve([
            "/api/v1/purchase/splitStart": { _ in Self.splitStart() },
            "/api/v1/purchase/checkSplit": { _ in Self.acceptedSplit },
            "/api/v1/purchase/split": { _ in Self.splitResult },
        ])
        let session = ExpenseSplitSession(expenseID: "EXP-4K7M", client: try makeClient())
        await session.load()
        let first = session.parts[0].id
        let second = session.parts[1].id
        session.update(first) {
            $0.name = "Saw"
            $0.cost = "0.1"
        }
        session.update(second) {
            $0.name = "Blade"
            $0.cost = "0.2"
        }
        _ = try await session.save(confirmed: true)

        // The check was asked about the parts as typed — text, not numbers the client added up.
        let asked = try #require(recorder.posts(to: "/api/v1/purchase/checkSplit").last)
        let askedParts = try #require(asked.body["parts"]?.arrayValue)
        #expect(askedParts.map { $0["cost"]?.stringValue } == ["0.1", "0.2"])
        #expect(asked.body["attributionPolicy"] == nil)

        let write = try #require(recorder.posts(to: "/api/v1/purchase/split").last)
        #expect(write.body["expenseId"]?.stringValue == "EXP-4K7M")
        let written = try #require(write.body["parts"]?.arrayValue)
        #expect(written.map { $0["name"]?.stringValue } == ["Saw", "Blade"])
        #expect(written.map { $0["cost"]?.doubleValue } == [0.1, 0.2])
    }

    @Test @MainActor func sendsTheAttributionChoiceOnlyOnceChosen() async throws {
        let recorder = serve([
            "/api/v1/purchase/splitStart": { _ in Self.splitStart() },
            "/api/v1/purchase/checkSplit": { _ in Self.acceptedSplit },
        ])
        let session = ExpenseSplitSession(expenseID: "EXP-4K7M", client: try makeClient())
        await session.load()
        session.attributionPolicy = "clear"
        await session.recheck()

        let asked = try #require(recorder.posts(to: "/api/v1/purchase/checkSplit").last)
        #expect(asked.body["attributionPolicy"]?.stringValue == "clear")
    }

    @Test @MainActor func onlyOnePartKeepsTheProduct() async throws {
        _ = serve(["/api/v1/purchase/splitStart": { _ in Self.splitStart(productNote: "Hands it over.") }])
        let session = ExpenseSplitSession(expenseID: "EXP-4K7M", client: try makeClient())
        await session.load()
        let first = session.parts[0].id
        let second = session.parts[1].id
        session.update(first) { $0.productQuantity = "2" }
        session.setProductPart(first, keep: true)
        session.setProductPart(second, keep: true)

        #expect(session.parts.map(\.keepProduct) == [false, true])
        #expect(session.parts[0].productQuantity.isEmpty)
    }

    @Test @MainActor func keepsAtLeastTwoPartsAndAtMostTheServersLimit() async throws {
        _ = serve(["/api/v1/purchase/splitStart": { _ in Self.splitStart() }])
        let session = ExpenseSplitSession(expenseID: "EXP-4K7M", client: try makeClient())
        await session.load()
        session.removePart(session.parts[0].id)
        #expect(session.parts.count == 2)
        session.addPart()
        #expect(session.parts.count == 3)
        #expect(session.parts[2].name.isEmpty && session.parts[2].cost.isEmpty)
    }

    // MARK: - Attach expenses fixtures

    nonisolated private static let expenseCandidates = """
        {"scopes":[{"value":"vendorOrUnattached","label":"This vendor or unattached"},
                   {"value":"unattached","label":"Unattached expenses only"},
                   {"value":"any","label":"Any expense"}],
         "candidates":[
           {"id":"EXP-AAAA","name":"Sample board","date":"2026-01-05","cost":12.5,"trade":"other",
            "projectId":null,"projectName":null,"current":"unattached","filed":false,
            "summary":"Jan 5 · $12.50 · unattached"},
           {"id":"EXP-BBBB","name":"Sample screws","date":null,"cost":null,"trade":null,
            "projectId":null,"projectName":null,"current":"Sample Supply","filed":true,
            "summary":"no cost recorded · on Sample Supply"}],
         "message":null,"caution":"Attaching an already-filed expense moves it."}
        """

    nonisolated private static func linkCheck(
        ids: [String]?, reason: String? = nil, confirm: String? = nil
    ) -> String {
        let idsJSON = ids.map { "[" + $0.map { "\"\($0)\"" }.joined(separator: ",") + "]" } ?? "null"
        let reasonJSON = reason.map { "\"\($0)\"" } ?? "null"
        let confirmJSON = confirm.map { "\"\($0)\"" } ?? "null"
        return """
            {"expenseIds":\(idsJSON),"selectedCount":\(ids?.count ?? 0),"selectedTotal":12.5,
             "resultingTotal":112.5,"movedCount":\(confirm == nil ? 0 : 1),"reason":\(reasonJSON),
             "note":"selected","confirm":\(confirmJSON)}
            """
    }

    /// A minimal Purchase the attach write answers with; the session reads none of it.
    nonisolated private static let purchaseOut = """
        {"bookingCoverage":"missing","documentCoverage":"missing","itemizationCoverage":"missing","productsCoverage":"missing","coverage":{"expectation":"unknown","booking":"missing","document":"missing","itemization":"missing","products":"missing"},"spendingCategorySummary":{"state":"single","categories":[],"lineCount":0,"categorizedLineCount":0,"uncategorizedLineCount":0,"complete":false,"amountsKnown":false},"spendingCategoryOrigin":"legacy","itemizationEvidence":false,"id":"x","vendorId":"x","orderId":"x","displayLabel":"x","date":"x","notes":"x","vendorName":"x","orderUrl":"x","expenseCount":0,"unpricedExpenseCount":0,"expenseTotal":0,"reconciliation":"unknown","financialReconciliation":{"status":"unknown","transactionCount":0,"postedTransactionCount":0,"outstandingTransactionCount":0,"postedTotal":0,"projectedTotal":0,"postedRefundTotal":0},"documentCount":0,"images":[],"displayName":"x","createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:00:00Z","dataQuality":{"status":"complete","score":0,"facets":[],"gaps":[],"exceptions":[],"relatedGaps":[],"relatedExceptions":[]}}
        """

    // MARK: - Attach expenses

    @Test @MainActor func asksTheServerForTheScopeAndSearchChosen() async throws {
        let recorder = serve([
            "/api/v1/purchase/linkExpenseCandidates": { _ in Self.expenseCandidates }
        ])
        let session = PurchaseExpenseLinkSession(purchaseID: "PUR-4K7M", client: try makeClient())
        await session.load()
        await session.setScope("any")
        await session.setSearch("board")

        let last = try #require(recorder.requests.last)
        #expect(last.query.contains("purchaseId=PUR-4K7M"))
        #expect(last.query.contains("scope=any"))
        #expect(last.query.contains("search=board"))
        #expect(session.candidates?.candidates.map(\.id) == ["EXP-AAAA", "EXP-BBBB"])
    }

    @Test @MainActor func neverAttachesWhatTheServerRefused() async throws {
        let recorder = serve([
            "/api/v1/purchase/checkLinkExpenses": { _ in
                Self.linkCheck(ids: nil, reason: "EXP-AAAA is already on this purchase.")
            },
            "/api/v1/purchase/link": { _ in Self.purchaseOut },
        ])
        let session = PurchaseExpenseLinkSession(purchaseID: "PUR-4K7M", client: try makeClient())
        session.toggle("EXP-AAAA")

        await #expect(
            throws: PurchaseExpenseLinkSession.Failure.refused("EXP-AAAA is already on this purchase.")
        ) {
            try await session.attach(confirmed: true)
        }
        #expect(recorder.posts(to: "/api/v1/purchase/link").isEmpty)
    }

    @Test @MainActor func movingExpensesOffAnotherPurchaseNeedsAConfirmation() async throws {
        let sentence = "Attaching moves 1 expense off its current purchase."
        let recorder = serve([
            "/api/v1/purchase/checkLinkExpenses": { _ in
                Self.linkCheck(ids: ["EXP-AAAA", "EXP-BBBB"], confirm: sentence)
            },
            "/api/v1/purchase/link": { _ in Self.purchaseOut },
        ])
        let session = PurchaseExpenseLinkSession(purchaseID: "PUR-4K7M", client: try makeClient())
        session.toggle("EXP-AAAA")
        session.toggle("EXP-BBBB")

        await #expect(throws: PurchaseExpenseLinkSession.Failure.needsConfirmation(sentence)) {
            try await session.attach(confirmed: false)
        }
        #expect(recorder.posts(to: "/api/v1/purchase/link").isEmpty)
    }

    @Test @MainActor func attachesExactlyTheIdsTheServerReturned() async throws {
        let recorder = serve([
            "/api/v1/purchase/checkLinkExpenses": { _ in
                Self.linkCheck(ids: ["EXP-AAAA"])
            },
            "/api/v1/purchase/link": { _ in Self.purchaseOut },
        ])
        let session = PurchaseExpenseLinkSession(purchaseID: "PUR-4K7M", client: try makeClient())
        session.toggle("EXP-AAAA")
        try await session.attach(confirmed: false)

        let asked = try #require(recorder.posts(to: "/api/v1/purchase/checkLinkExpenses").last)
        #expect(asked.body["purchaseId"]?.stringValue == "PUR-4K7M")
        #expect(asked.body["expenseIds"]?.arrayValue?.compactMap(\.stringValue) == ["EXP-AAAA"])
        let write = try #require(recorder.posts(to: "/api/v1/purchase/link").last)
        #expect(write.body["expenseIds"]?.arrayValue?.compactMap(\.stringValue) == ["EXP-AAAA"])
        #expect(session.selection.isEmpty)
    }

    @Test @MainActor func sendsNothingWhenNothingIsSelected() async throws {
        let recorder = serve([:])
        let session = PurchaseExpenseLinkSession(purchaseID: "PUR-4K7M", client: try makeClient())
        await #expect(throws: PurchaseExpenseLinkSession.Failure.nothingSelected) {
            try await session.attach(confirmed: true)
        }
        #expect(recorder.requests.isEmpty)
    }

    // MARK: - Attach products

    nonisolated private static let productCandidates = """
        {"candidates":[
           {"id":"PRD-AAAA","name":"Sample saw","manufacturer":"Sample Maker","price":19.5,"coverImageUrl":null},
           {"id":"PRD-BBBB","name":"Sample blade","manufacturer":"Sample Maker","price":null,"coverImageUrl":null}],
         "message":null,
         "note":"The link carries no money or quantity."}
        """

    @Test @MainActor func attachesExactlyTheCheckedProducts() async throws {
        let recorder = serve([
            "/api/v1/purchase/linkProductCandidates": { _ in Self.productCandidates },
            "/api/v1/purchase/attachProducts": { _ in
                "{\"changed\":2,\"attached\":2,\"alreadySatisfied\":0}"
            },
        ])
        let session = PurchaseProductLinkSession(purchaseID: "PUR-4K7M", client: try makeClient())
        await session.setSearch("saw")
        session.toggle("PRD-BBBB")
        session.toggle("PRD-AAAA")
        let changed = try await session.attach()

        #expect(changed == 2)
        let search = try #require(recorder.requests.first)
        #expect(search.query.contains("search=saw"))
        let write = try #require(recorder.posts(to: "/api/v1/purchase/attachProducts").last)
        #expect(write.body["purchaseId"]?.stringValue == "PUR-4K7M")
        #expect(write.body["productIds"]?.arrayValue?.compactMap(\.stringValue) == ["PRD-BBBB", "PRD-AAAA"])
    }

    @Test @MainActor func sendsNothingWhenNoProductIsChecked() async throws {
        let recorder = serve([:])
        let session = PurchaseProductLinkSession(purchaseID: "PUR-4K7M", client: try makeClient())
        await #expect(throws: PurchaseProductLinkSession.Failure.nothingSelected) {
            try await session.attach()
        }
        #expect(recorder.requests.isEmpty)
    }
}
