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
    /// The server requires a note, so a blank one falls back to the reason's own label.
    public func setInput(reason: DataExceptionReason, label: String, note: String) -> SetDataExceptionInput? {
        guard let check = DataCheck(rawValue: check) else { return nil }
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return .init(
            entityId: entityID, check: check, reason: reason, note: trimmed.isEmpty ? label : trimmed)
    }

    public func clearInput() -> ClearDataExceptionInput? {
        guard let check = DataCheck(rawValue: check) else { return nil }
        return .init(entityId: entityID, check: check)
    }
}
