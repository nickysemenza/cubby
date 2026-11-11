import Foundation

/// One pending field Suggestion on a record, as `suggestions.list` reports it. Accepting and
/// dismissing go through `suggestion.review(Batch)`; the server applies, verifies and records the
/// outcome (ADR 0025), so nothing here decides whether a suggestion is right.
public struct PendingFieldSuggestion: Sendable, Hashable, Identifiable {
    public let id: String
    public let suggestionID: String
    public let field: String
    public let suggestedValue: JSONValue
    /// The listed version a review names as `expectedFingerprint`.
    public let fingerprint: String
    /// Bulk-acceptable as is (`clean`); only clean rows join Accept all.
    public let clean: Bool
    public let canAccept: Bool
    public let canDismiss: Bool

    public init(
        id: String, suggestionID: String, field: String, suggestedValue: JSONValue,
        fingerprint: String, clean: Bool = false, canAccept: Bool = true, canDismiss: Bool = true
    ) {
        self.id = id
        self.suggestionID = suggestionID
        self.field = field
        self.suggestedValue = suggestedValue
        self.fingerprint = fingerprint
        self.clean = clean
        self.canAccept = canAccept
        self.canDismiss = canDismiss
    }

    init(_ row: FieldSuggestionRow) {
        let verbs = Set(row.actions.map(\.verb))
        self.init(
            id: row.id, suggestionID: row.suggestionId, field: row.evidence.field,
            suggestedValue: row.evidence.suggestedValue, fingerprint: row.fingerprint, clean: row.clean,
            canAccept: verbs.contains(.accept),
            canDismiss: verbs.contains(.dismiss) || verbs.contains(.reject))
    }

    /// Accept applies the stored value; Dismiss records the miss without changing the record,
    /// matching web's stored-suggestion review.
    func review(accept: Bool) -> SuggestionReviewInput {
        SuggestionReviewInput(
            operationId: UUID().uuidString, verdict: accept ? .correct : .wrong,
            correction: .value1(SuggestionCorrectionFalse(present: .falseValue)), reason: .value(nil),
            evidence: .value(nil), intent: accept ? .apply : .history, suggestionId: suggestionID,
            expectedFingerprint: fingerprint)
    }
}

extension CubbyClient {
    /// The record's pending field Suggestions, every page.
    public func pendingFieldSuggestions(entity: EntityKey, id: String) async throws
        -> [PendingFieldSuggestion]
    {
        var items: [PendingFieldSuggestion] = []
        var cursor: String?
        repeat {
            let page = try await native_suggestions_list(
                body: SuggestionListInput(
                    family: .field, recordEntity: .init(rawValue: entity.rawValue), recordIds: [id],
                    status: .pending, cursor: cursor, limit: 200))
            for row in page.items {
                if case .field(let field) = row { items.append(PendingFieldSuggestion(field)) }
            }
            cursor = page.next
        } while cursor != nil
        return items
    }

    /// Accepts or dismisses one Suggestion.
    public func review(_ suggestion: PendingFieldSuggestion, accept: Bool) async throws {
        _ = try await reviewSuggestion(suggestion.review(accept: accept))
    }

    /// Accepts several Suggestions in one batch; returns the per-item refusals the server gave.
    public func accept(_ suggestions: [PendingFieldSuggestion]) async throws -> [String] {
        let results = try await reviewSuggestions(
            SuggestionReviewBatchInput(items: suggestions.map { $0.review(accept: true) }))
        return results.compactMap { result in
            if case .value2(let refusal) = result { return refusal.error }
            return nil
        }
    }
}
