import Foundation

/// The wire inputs for accepting or clearing one explained data-quality check. The allowed reasons
/// and their labels come from the server's explanation, so this type only shapes the request.
public struct DataExceptionDraft: Equatable, Sendable {
    public let entityID: String
    public let check: String

    public init(entityID: String, check: String) {
        self.entityID = entityID
        self.check = check
    }

    /// `nil` when `check` is not one this client knows (a newer server), so the action stays hidden.
    /// A finding requires an explanation of the evidence checked.
    public func setInput(reason: DataExceptionReason, note: String) -> SetDataExceptionInput? {
        guard let check = DataCheck(rawValue: check) else { return nil }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return .init(
            entityId: entityID, check: check, reason: reason, note: trimmed)
    }

    public func clearInput() -> ClearDataExceptionInput? {
        guard let check = DataCheck(rawValue: check) else { return nil }
        return .init(entityId: entityID, check: check)
    }
}
