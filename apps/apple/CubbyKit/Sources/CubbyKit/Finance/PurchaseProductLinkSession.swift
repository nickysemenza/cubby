import CubbyAPI
import Foundation
import Observation

/// "Attach products" for one Purchase: record which products an order bought. The candidates (a
/// product search minus what is already attached on purpose) and the wording come from the server
/// (`purchase.linkProductCandidates`). The link carries no money or quantity, so attaching changes
/// no spend and no inventory; it is still an explicit tap that sends exactly the checked products.
@MainActor
@Observable
public final class PurchaseProductLinkSession {
    public enum State {
        case loading
        case loaded(PurchaseLinkProductsCandidatesOut)
        case failed(String)
    }

    public enum Failure: Error, Equatable, Sendable {
        case nothingSelected
    }

    public let purchaseID: String
    public private(set) var state: State = .loading
    public private(set) var search = ""
    /// Checked product ids, in the order they were checked; survives a new search.
    public private(set) var selection: [String] = []
    public private(set) var isSaving = false

    private let client: CubbyClient
    private var loadGeneration = 0

    public init(purchaseID: String, client: CubbyClient) {
        self.purchaseID = purchaseID
        self.client = client
    }

    public var candidates: PurchaseLinkProductsCandidatesOut? {
        if case .loaded(let candidates) = state { return candidates }
        return nil
    }

    public func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        do {
            let answer = try await client.purchaseLinkProductCandidates(
                .init(purchaseId: purchaseID, search: search.isEmpty ? nil : search))
            if generation == loadGeneration { state = .loaded(answer) }
        } catch {
            if generation == loadGeneration { state = .failed(error.userMessage) }
        }
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
    }

    public var canAttach: Bool { !selection.isEmpty && !isSaving }

    /// Attaches exactly the checked products. Throws before any request when none are checked.
    /// Returns how many links the server created.
    @discardableResult
    public func attach() async throws -> Int {
        guard !selection.isEmpty else { throw Failure.nothingSelected }
        isSaving = true
        defer { isSaving = false }
        let result = try await client.attachProductsToPurchase(
            .init(purchaseId: purchaseID, productIds: selection.map { ProductCode($0) }))
        selection = []
        return result.changed
    }
}
