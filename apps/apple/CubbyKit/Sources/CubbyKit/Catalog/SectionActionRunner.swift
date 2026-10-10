import CubbyAPI
import Foundation

/// Why a section verb did not run. Each case is raised before any request goes out.
public enum SectionActionError: Error, Equatable, Sendable {
    /// The report does not offer the verb, or offers it with a reason the server gave.
    case unavailable(String)
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

}
