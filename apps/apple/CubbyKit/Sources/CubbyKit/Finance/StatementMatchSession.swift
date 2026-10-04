import CubbyAPI
import Foundation
import Observation

/// "Match statement activity" for one Purchase: review the unallocated statement entries the
/// server found near the order, optionally ask for an advisory ordering, choose one, and allocate
/// it across Purchases. Native does exactly what web's dialog does and nothing it would not:
///
/// - The candidates, their wording, the tie that offers "Suggest a match", the rows an allocation
///   starts from, and whether typed rows can be saved all come from the server
///   (`purchase.settlementCandidates`, `purchase.checkSettlementAllocation`).
/// - A suggestion only reorders and badges the tied candidates. It never selects one, fills a
///   row, or writes; `suggest()` has no path to `save()`.
/// - Saving re-asks the server about exactly the rows typed now and writes only the allocations
///   it returns, as the transaction's own allocation update (which validates again). A refused
///   check sends nothing.
@MainActor
@Observable
public final class StatementMatchSession {
    public enum State {
        case loading
        case loaded(PurchaseSettlementCandidatesOut)
        case failed(String)
    }

    /// One editable allocation row. The purchase code is blank until chosen.
    public struct Row: Identifiable, Equatable, Sendable {
        public let id: UUID
        public var purchaseID: String
        public var amount: String

        public init(id: UUID = UUID(), purchaseID: String, amount: String) {
            self.id = id
            self.purchaseID = purchaseID
            self.amount = amount
        }
    }

    public enum Failure: Error, Equatable, Sendable {
        case nothingSelected
        /// The server's reason the typed rows cannot be saved.
        case refused(String)
    }

    public let purchaseID: String
    public private(set) var state: State = .loading
    public private(set) var suggestion: PurchaseSettlementSuggestOut?
    public private(set) var suggestionError: String?
    public private(set) var isSuggesting = false
    public private(set) var selectedTransactionID: String?
    public private(set) var rows: [Row] = []
    /// The server's last answer about `rows`; nil before any row is typed.
    public private(set) var check: PurchaseSettlementAllocationCheckOut?
    public private(set) var isSaving = false
    public private(set) var didSave = false

    private let client: CubbyClient
    private var checkGeneration = 0

    public init(purchaseID: String, client: CubbyClient) {
        self.purchaseID = purchaseID
        self.client = client
    }

    public var candidates: PurchaseSettlementCandidatesOut? {
        if case .loaded(let candidates) = state { return candidates }
        return nil
    }

    public func load() async {
        do {
            state = .loaded(try await client.purchaseSettlementCandidates(.init(purchaseId: purchaseID)))
        } catch {
            state = .failed(error.userMessage)
        }
    }

    // MARK: - Suggestion (advisory)

    /// Asks the server to order the tied candidates. The result is shown, never applied.
    public func suggest() async {
        guard !isSuggesting else { return }
        isSuggesting = true
        suggestionError = nil
        defer { isSuggesting = false }
        do {
            suggestion = try await client.suggestPurchaseSettlementMatch(.init(purchaseId: purchaseID))
        } catch {
            suggestion = nil
            suggestionError = error.userMessage
        }
    }

    /// The text to show beside "Suggest a match": the server's note once asked, its hint before.
    public var suggestionNote: String? {
        if let suggestionError { return "Suggestion unavailable: \(suggestionError)" }
        if let suggestion { return Self.note(of: suggestion) }
        return candidates?.suggestHint
    }

    /// Candidate transaction ids in the order to show: the server's `displayOrder` once a
    /// suggestion ranked them, else the order the server listed them.
    public var displayOrder: [String] {
        let listed = (candidates?.candidates ?? []).map(\.transaction.id)
        guard let suggestion, let order = Self.displayOrder(of: suggestion) else { return listed }
        let position = Dictionary(uniqueKeysWithValues: order.enumerated().map { ($1, $0) })
        return listed.sorted { (position[$0] ?? listed.count) < (position[$1] ?? listed.count) }
    }

    /// The server's badge for a candidate (`Suggested · 72%`), if a suggestion ranked it.
    public func badge(for transactionID: String) -> String? {
        guard let suggestion else { return nil }
        return Self.badge(of: suggestion, for: transactionID)
    }

    // MARK: - Allocation

    /// Chooses a candidate. The rows start from the server's proposal; nothing is saved.
    public func select(_ transactionID: String) {
        guard let candidate = candidates?.candidates.first(where: { $0.transaction.id == transactionID })
        else { return }
        selectedTransactionID = transactionID
        rows = candidate.proposedAllocations.map { Row(purchaseID: $0.purchaseId, amount: $0.amount) }
        check = nil
        didSave = false
    }

    public func addRow() {
        rows.append(Row(purchaseID: "", amount: ""))
    }

    public func setPurchaseID(_ value: String, for rowID: UUID) {
        guard let index = rows.firstIndex(where: { $0.id == rowID }) else { return }
        rows[index].purchaseID = value
    }

    public func setAmount(_ value: String, for rowID: UUID) {
        guard let index = rows.firstIndex(where: { $0.id == rowID }) else { return }
        rows[index].amount = value
    }

    /// Asks the server whether the current rows can be saved. A slower answer to older rows never
    /// replaces a newer one.
    public func recheck() async {
        guard let transactionID = selectedTransactionID else { return }
        checkGeneration += 1
        let generation = checkGeneration
        do {
            let answer = try await askServer(transactionID: transactionID, rows: rows)
            if generation == checkGeneration { check = answer }
        } catch {
            if generation == checkGeneration { check = nil }
        }
    }

    public var canSave: Bool { selectedTransactionID != nil && check?.allocations != nil && !isSaving }

    /// Saves the allocation: asks about exactly the rows typed now, and writes only what the
    /// server returns. Throws `Failure.refused` (and sends no write) when the server says no.
    public func save() async throws {
        guard let transactionID = selectedTransactionID else { throw Failure.nothingSelected }
        isSaving = true
        defer { isSaving = false }
        let latest = try await askServer(transactionID: transactionID, rows: rows)
        check = latest
        guard let allocations = latest.allocations else {
            throw Failure.refused(latest.reason ?? "These allocations cannot be saved.")
        }
        let values: JSONValue = .array(
            allocations.map {
                .object(["purchaseId": .string($0.purchaseId), "amount": .number($0.amount)])
            })
        try await client.update(
            EntityCatalog[.financialTransaction], id: transactionID,
            patch: EntityPatch(values: ["allocations": values]))
        didSave = true
    }

    // MARK: - The server's suggestion, read as given

    private static func note(of suggestion: PurchaseSettlementSuggestOut) -> String {
        switch suggestion {
        case .notAmbiguous(let result): result.note
        case .ranked(let result): result.note
        case .unavailable(let result): result.note
        }
    }

    private static func displayOrder(of suggestion: PurchaseSettlementSuggestOut) -> [String]? {
        if case .ranked(let result) = suggestion { return result.displayOrder }
        return nil
    }

    private static func badge(of suggestion: PurchaseSettlementSuggestOut, for transactionID: String)
        -> String?
    {
        guard case .ranked(let result) = suggestion else { return nil }
        return result.ranked.first { $0.transactionId == transactionID }?.badge
    }

    private func askServer(transactionID: String, rows: [Row]) async throws
        -> PurchaseSettlementAllocationCheckOut
    {
        try await client.checkPurchaseSettlementAllocation(
            .init(
                transactionId: transactionID,
                allocations: rows.map { .init(purchaseId: $0.purchaseID, amount: $0.amount) }))
    }
}
