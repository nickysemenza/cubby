import CubbyAPI
import Foundation
import Observation

/// "Attach existing expenses" for one Purchase. Native does exactly what web's dialog does:
///
/// - Which expenses are candidates for a scope and search, how each is worded and where it is
///   filed now, what the selection does to the Purchase's expense total, and whether anything
///   would move off another purchase all come from the server
///   (`purchase.linkExpenseCandidates`, `purchase.checkLinkExpenses`).
/// - Attaching moves expenses between purchases, so when the server says some would move off
///   another purchase the person must confirm first (`needsConfirmation`, raised before any
///   request). A refused check sends no write, and the write sends only the ids the server
///   returned.
@MainActor
@Observable
public final class PurchaseExpenseLinkSession {
    public enum State {
        case loading
        case loaded(PurchaseLinkExpensesCandidatesOut)
        case failed(String)
    }

    public enum Failure: Error, Equatable, Sendable {
        case nothingSelected
        /// The server's sentence about expenses that would move; raised before any request.
        case needsConfirmation(String)
        /// The server's reason the selection cannot be attached.
        case refused(String)
    }

    public let purchaseID: String
    public private(set) var state: State = .loading
    /// The scope's wire value (`vendorOrUnattached` by default).
    public private(set) var scope = "vendorOrUnattached"
    public private(set) var search = ""
    /// Checked expense ids, in the order they were checked; survives a change of scope or search.
    public private(set) var selection: [String] = []
    /// The server's last answer about `selection`; nil when nothing is selected.
    public private(set) var check: PurchaseLinkExpensesCheckOut?
    public private(set) var isSaving = false

    private let client: CubbyClient
    private var loadGeneration = 0
    private var checkGeneration = 0

    public init(purchaseID: String, client: CubbyClient) {
        self.purchaseID = purchaseID
        self.client = client
    }

    public var candidates: PurchaseLinkExpensesCandidatesOut? {
        if case .loaded(let candidates) = state { return candidates }
        return nil
    }

    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        do {
            let answer = try await client.purchaseLinkExpenseCandidates(
                .init(
                    purchaseId: purchaseID,
                    scope: CubbyClient.PurchaseLinkExpenseCandidatesQuery.ScopePayload(rawValue: scope),
                    search: search.isEmpty ? nil : search))
            if generation == loadGeneration { state = .loaded(answer) }
        } catch {
            if generation == loadGeneration { state = .failed(error.userMessage) }
        }
    }

    public func setScope(_ value: String) async {
        scope = value
        await load()
    }

    public func setSearch(_ value: String) async {
        search = value
        await load()
    }

    public func isSelected(_ id: String) -> Bool { selection.contains(id) }

    public func toggle(_ id: String) {
        if let index = selection.firstIndex(of: id) {
            selection.remove(at: index)
        } else {
            selection.append(id)
        }
        // The old answer described a different selection.
        checkGeneration += 1
        check = nil
    }

    /// Asks the server what the current selection does and whether it can be attached.
    public func recheck() async {
        guard !selection.isEmpty else {
            check = nil
            return
        }
        checkGeneration += 1
        let generation = checkGeneration
        do {
            let answer = try await askServer()
            if generation == checkGeneration { check = answer }
        } catch {
            if generation == checkGeneration { check = nil }
        }
    }

    public var canAttach: Bool { check?.expenseIds != nil && !isSaving }

    /// Attaches the selection: asks about exactly what is selected now and writes only the ids the
    /// server returns. Throws (before any write) when nothing is selected, when the server
    /// refuses, or when expenses would move and `confirmed` is false.
    public func attach(confirmed: Bool) async throws {
        guard !selection.isEmpty else { throw Failure.nothingSelected }
        isSaving = true
        defer { isSaving = false }
        checkGeneration += 1
        let latest = try await askServer()
        check = latest
        guard let ids = latest.expenseIds else {
            throw Failure.refused(latest.reason ?? "These expenses cannot be attached.")
        }
        if let confirm = latest.confirm, !confirmed { throw Failure.needsConfirmation(confirm) }
        _ = try await client.attachExpensesToPurchase(.init(purchaseId: purchaseID, expenseIds: ids))
        selection = []
        check = nil
    }

    private func askServer() async throws -> PurchaseLinkExpensesCheckOut {
        try await client.checkPurchaseExpenseLink(
            .init(purchaseId: purchaseID, expenseIds: selection))
    }
}
