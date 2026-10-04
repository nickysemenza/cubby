import CubbyAPI
import Foundation
import Observation

/// "Split" for one Expense: replace it with parts filed under its Purchase. Native does exactly
/// what web's dialog does and nothing it would not:
///
/// - The starting parts, the wording, the sentence that confirms the expense is deleted, and
///   whether typed parts can be saved (a name each, whole cents that add up to the original
///   exactly, one product part, an attribution choice) all come from the server
///   (`purchase.splitStart`, `purchase.checkSplit`). The session holds no split math.
/// - Saving needs an explicit confirmation, re-asks the server about exactly the parts typed now,
///   and sends only the body it returned. A refused check sends no write, and the write
///   validates again.
@MainActor
@Observable
public final class ExpenseSplitSession {
    public enum State {
        case loading
        case loaded(PurchaseSplitStartOut)
        case failed(String)
    }

    /// One editable part. Every field stays text or a plain choice so a half-typed amount is
    /// representable; `projectID` is blank for none.
    public struct Part: Identifiable, Equatable, Sendable {
        public let id: UUID
        public var name: String
        public var cost: String
        public var costType: String
        public var trade: String?
        public var projectID: String
        public var keepProduct: Bool
        public var productQuantity: String

        public init(
            id: UUID = UUID(), name: String, cost: String, costType: String, trade: String?,
            projectID: String, keepProduct: Bool, productQuantity: String
        ) {
            self.id = id
            self.name = name
            self.cost = cost
            self.costType = costType
            self.trade = trade
            self.projectID = projectID
            self.keepProduct = keepProduct
            self.productQuantity = productQuantity
        }

        /// The wire object the check takes; also how a part is read back from the server's seed.
        var json: JSONValue {
            .object([
                "name": .string(name),
                "cost": .string(cost),
                "costType": .string(costType),
                "trade": trade.map(JSONValue.string) ?? .null,
                "projectId": .string(projectID),
                "keepProduct": .bool(keepProduct),
                "productQuantity": .string(productQuantity),
            ])
        }

        init(seed: SplitPartDraft) throws {
            let json = try JSONValue(encoding: seed)
            self.init(
                name: json["name"]?.stringValue ?? "", cost: json["cost"]?.stringValue ?? "",
                costType: json["costType"]?.stringValue ?? "", trade: json["trade"]?.stringValue,
                projectID: json["projectId"]?.stringValue ?? "",
                keepProduct: json["keepProduct"]?.boolValue ?? false,
                productQuantity: json["productQuantity"]?.stringValue ?? "")
        }
    }

    public enum Failure: Error, Equatable, Sendable {
        case notLoaded
        /// Raised before any request: the person has not confirmed that the expense is replaced.
        /// Carries the server's sentence to show.
        case needsConfirmation(String)
        /// The server's reason the typed parts cannot be saved.
        case refused(String)
    }

    public let expenseID: String
    public private(set) var state: State = .loading
    public private(set) var parts: [Part] = []
    /// The server's last answer about `parts`; nil before any part is typed.
    public private(set) var check: PurchaseSplitCheckOut?
    public private(set) var isSaving = false
    /// `inherit` or `clear`; sent only when the server says the expense carries attribution.
    public var attributionPolicy: String?

    private let client: CubbyClient
    private var checkGeneration = 0

    public init(expenseID: String, client: CubbyClient) {
        self.expenseID = expenseID
        self.client = client
    }

    public var start: PurchaseSplitStartOut? {
        if case .loaded(let start) = state { return start }
        return nil
    }

    /// Reads the starting parts. They are the server's: the whole cost on the first part, the
    /// second empty, both carrying the original's type, trade and project.
    public func load() async {
        do {
            let start = try await client.startExpenseSplit(.init(expenseId: expenseID))
            parts = try start.parts.map(Part.init(seed:))
            state = .loaded(start)
            check = nil
        } catch {
            state = .failed(error.userMessage)
        }
    }

    // MARK: - Editing

    public func update(_ id: UUID, _ edit: (inout Part) -> Void) {
        guard let index = parts.firstIndex(where: { $0.id == id }) else { return }
        edit(&parts[index])
    }

    public var canAddPart: Bool {
        guard let start else { return false }
        return parts.count < start.maxParts
    }

    /// A new part starts like the server's empty second part.
    public func addPart() {
        guard canAddPart, let template = start?.parts.dropFirst().first,
            let part = try? Part(seed: template)
        else { return }
        parts.append(part)
    }

    public func removePart(_ id: UUID) {
        guard parts.count > 2 else { return }
        parts.removeAll { $0.id == id }
    }

    /// At most one part inherits the product link, so setting it clears the others.
    public func setProductPart(_ id: UUID, keep: Bool) {
        for index in parts.indices {
            let isThis = parts[index].id == id
            parts[index].keepProduct = keep && isThis
            if !(keep && isThis) { parts[index].productQuantity = "" }
        }
    }

    // MARK: - The server's answer

    /// Asks the server whether the current parts can be saved. A slower answer to older parts
    /// never replaces a newer one.
    public func recheck() async {
        guard start != nil else { return }
        checkGeneration += 1
        let generation = checkGeneration
        do {
            let answer = try await askServer()
            if generation == checkGeneration { check = answer }
        } catch {
            if generation == checkGeneration { check = nil }
        }
    }

    public var canSave: Bool { start != nil && check?.split != nil && !isSaving }

    /// What the person must confirm before the write: the expense is replaced, not added to.
    public var confirmation: String? { start?.confirm }

    /// Saves the split: needs `confirmed`, asks about exactly the parts typed now, and writes only
    /// the body the server returns. Returns the new expenses' ids. Throws before any write when
    /// not confirmed (`needsConfirmation`) or when the server refuses (`refused`).
    public func save(confirmed: Bool) async throws -> [String] {
        guard let start else { throw Failure.notLoaded }
        guard confirmed else { throw Failure.needsConfirmation(start.confirm) }
        isSaving = true
        defer { isSaving = false }
        checkGeneration += 1
        let latest = try await askServer()
        check = latest
        guard let split = latest.split else {
            throw Failure.refused(latest.reason ?? "These parts cannot be saved.")
        }
        // The check's body is the write's body; only the generated type differs.
        let body: SplitExpenseInputRequest = try JSONValue(encoding: split).decoded()
        return try await client.splitExpense(body).map(\.id)
    }

    private func askServer() async throws -> PurchaseSplitCheckOut {
        var body: [String: JSONValue] = [
            "expenseId": .string(expenseID),
            "parts": .array(parts.map(\.json)),
        ]
        if let attributionPolicy { body["attributionPolicy"] = .string(attributionPolicy) }
        return try await client.checkExpenseSplit(JSONValue.object(body).decoded())
    }
}
