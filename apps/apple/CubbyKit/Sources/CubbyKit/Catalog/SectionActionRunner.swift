import CubbyAPI
import Foundation

/// Why a section verb did not run. Each case is raised before any request goes out.
public enum SectionActionError: Error, Equatable, Sendable {
    /// The report does not offer the verb, or offers it with a reason the server gave.
    case unavailable(String)
    /// A `selection` verb ran with nothing checked.
    case nothingSelected
    /// A checked row is one the server refused; carries its reason.
    case refusedSelection(String)
    /// Native does not implement the verb (`native-coverage.ts`); carries the reason.
    case unsupported(String)
}

/// Runs the verbs a finance report's `records` block offers, through the same operations web's
/// handlers call. The runner holds no rule of its own: availability is the server's
/// `disabledReason` on the verb and on each row, and the server refuses the whole request again
/// if anything changed. It never settles, searches or allocates unless the person invoked the verb.
public struct SectionActionRunner: Sendable {
    public let client: CubbyClient

    public init(client: CubbyClient) {
        self.client = client
    }

    /// How native treats a verb: `implemented`, or `unsupported` with the reason to show.
    public static func coverage(of action: SectionActionID) -> NativeCoverageStatus {
        NativeCoverageManifest.shared.sectionAction[action.rawValue]
            ?? .unsupported("This action is available on web.")
    }

    /// Throws unless `verb` is implemented natively and the report offers it available.
    public static func canOpen(_ verb: SectionActionID, in records: ReportPresentation.Records) throws {
        if case .unsupported(let reason) = coverage(of: verb) { throw SectionActionError.unsupported(reason) }
        guard let action = records.verb(verb) else {
            throw SectionActionError.unavailable("This action is not offered here.")
        }
        if let reason = action.disabledReason { throw SectionActionError.unavailable(reason) }
    }

    /// `splitExpense`: opens the split for `expenseID`. Throws, sending nothing, unless the report
    /// offers the verb available (the server leaves it unavailable, with its reason, for an
    /// expense with no purchase). The session asks the server for everything else.
    @MainActor
    public func splitSession(
        expenseID: String, records: ReportPresentation.Records
    ) throws -> ExpenseSplitSession {
        try Self.canOpen(.splitExpense, in: records)
        return ExpenseSplitSession(expenseID: expenseID, client: client)
    }

    /// `linkExpenses`: opens attaching existing expenses to `purchaseID`.
    @MainActor
    public func expenseLinkSession(
        purchaseID: String, records: ReportPresentation.Records
    ) throws -> PurchaseExpenseLinkSession {
        try Self.canOpen(.linkExpenses, in: records)
        return PurchaseExpenseLinkSession(purchaseID: purchaseID, client: client)
    }

    /// `linkProducts`: opens attaching products to `purchaseID`.
    @MainActor
    public func productLinkSession(
        purchaseID: String, records: ReportPresentation.Records
    ) throws -> PurchaseProductLinkSession {
        try Self.canOpen(.linkProducts, in: records)
        return PurchaseProductLinkSession(purchaseID: purchaseID, client: client)
    }

    /// `searchCharges`: one browser run for exactly the checked statement charges. Returns the
    /// new run's id. Nothing is sent unless the verb is offered, something is checked, and every
    /// checked row is one the server still allows.
    public func searchCharges(
        vendorAccountID: String, records: ReportPresentation.Records, selection: Set<String>
    ) async throws -> String {
        try Self.canOpen(.searchCharges, in: records)
        guard !selection.isEmpty else { throw SectionActionError.nothingSelected }
        for id in selection {
            guard let item = records.rows.first(where: { $0.key == id }) else {
                throw SectionActionError.refusedSelection("This charge is no longer listed.")
            }
            if let reason = item.disabledReason { throw SectionActionError.refusedSelection(reason) }
        }
        // Listed order, so the same selection always sends the same body.
        let ids = records.rows.compactMap(\.key).filter(selection.contains)
        return try await client.startChargeRun(
            .init(vendorAccountId: vendorAccountID, transactionIds: ids)
        ).runId
    }
}
