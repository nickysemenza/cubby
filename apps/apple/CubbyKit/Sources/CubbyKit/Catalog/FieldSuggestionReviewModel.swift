import Foundation
import Observation

/// Manifest eligibility and typed server proposals feed explicit review; inference never changes the draft.
@MainActor
@Observable
public final class FieldSuggestionReviewModel {
    public enum Acceptance: Equatable, Sendable {
        case draft
        case saved(field: String, value: JSONValue)
    }

    public let editor: GenericEntityEditModel
    public private(set) var response: FieldSuggestionsReviewOut?
    public private(set) var isLoading = false
    public private(set) var isApplying = false

    private var scope = FieldSuggestionReviewScope()
    private var ticket: FieldSuggestionReviewScope.Ticket?
    private var reviewedValues: [String: JSONValue] = [:]
    private var dismissed: Set<String> = []
    private let runKey = UUID().uuidString
    private let fetch: (FieldSuggestionsInput) async throws -> FieldSuggestionsReviewOut
    private let saveCategory: (FinanceCategoryApplyInput) async throws -> FinanceCategoryApplyOut

    public init(
        editor: GenericEntityEditModel,
        fetch: @escaping (FieldSuggestionsInput) async throws -> FieldSuggestionsReviewOut,
        saveCategory: @escaping (FinanceCategoryApplyInput) async throws -> FinanceCategoryApplyOut
    ) {
        self.editor = editor
        self.fetch = fetch
        self.saveCategory = saveCategory
    }

    public var fields: [FieldDescriptor] {
        editor.visibleFields.filter {
            $0.suggestion != nil && ($0.suggestion?.mode ?? "fill") == "fill"
                && !editor.readOnly($0.key) && $0.reference?.multiple != true
                && [.text, .enum, .identifier].contains($0.kind)
        }
    }

    private func currentValue(_ key: String) -> JSONValue {
        editor.draft[key] ?? editor.original?[key] ?? .null
    }

    public func proposal(_ key: String) -> FieldSuggestion? {
        guard let ticket, scope.accepts(ticket), !dismissed.contains(key),
            let field = fields.first(where: { $0.key == key }),
            ([key] + (field.suggestion?.basis ?? [])).allSatisfy({
                currentValue($0) == (reviewedValues[$0] ?? .null)
            }),
            let proposed = response?.suggestions.first(where: { $0.field == key })?.suggestion,
            proposed.operation == .set, proposed.value != nil
        else { return nil }
        if let review = proposed.financeReview {
            guard !editor.isCreate, review.entity.rawValue == editor.descriptor.key.rawValue,
                review.entityId == editor.recordID
            else { return nil }
        }
        return proposed
    }

    public func request() async throws {
        guard !isApplying, !fields.isEmpty else { return }
        let next = scope.beginRequest()
        guard scope.accepts(next) else { return }
        ticket = next
        response = nil
        dismissed = []
        let keys = Set(fields.flatMap { [$0.key] + ($0.suggestion?.basis ?? []) })
        reviewedValues = Dictionary(uniqueKeysWithValues: keys.map { ($0, currentValue($0)) })
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var basis: [String: String?] = try Dictionary(
            uniqueKeysWithValues: reviewedValues.map { key, value in
                if value == .null { return (key, nil) }
                if let string = value.stringValue { return (key, string) }
                return (key, String(decoding: try encoder.encode(value), as: UTF8.self))
            })
        let patch = try editor.patch()
        let draftFields = Set(patch.values.keys).union(patch.cleared).sorted()
        basis["__draftFields"] = String(decoding: try encoder.encode(draftFields), as: UTF8.self)
        isLoading = true
        defer { if scope.accepts(next) { isLoading = false } }
        do {
            let result = try await fetch(
                .init(
                    // Suggestible catalog entities and this generated enum share the shortcode entity roster.
                    entityId: editor.recordID, basisMode: .provided,
                    entity: .init(rawValue: editor.descriptor.key.rawValue)!,
                    targets: fields.map(\.key), basis: .init(additionalProperties: basis), runKey: runKey))
            if scope.accepts(next) { response = result }
        } catch {
            if scope.accepts(next) { response = nil }
            throw error
        }
    }

    /// Policy and draft suggestions are local edits. Saved finance reviews use the atomic server command.
    public func apply(_ key: String) async throws -> Acceptance? {
        guard !isApplying, let proposed = proposal(key), let value = proposed.value, let ticket else {
            return nil
        }
        let reviewedDraft = currentValue(key)
        if let review = proposed.financeReview {
            guard ["spendingCategoryId", "defaultSpendingCategoryId", "spendingProfile"].contains(key) else {
                return nil
            }
            isApplying = true
            defer { isApplying = false }
            do {
                let saved = try await saveCategory(
                    .init(
                        // Both generated enums come from financeCategoryReviewSchema.
                        entity: .init(rawValue: review.entity.rawValue)!, entityId: review.entityId,
                        fingerprint: review.fingerprint, field: .init(rawValue: key),
                        spendingCategoryId: key == "spendingCategoryId" ? value : nil,
                        defaultSpendingCategoryId: key == "defaultSpendingCategoryId" ? value : nil,
                        spendingProfile: key == "spendingProfile" ? .init(rawValue: value) : nil))
                guard scope.accepts(ticket) else { return nil }
                let savedValue =
                    key == "spendingProfile"
                    ? saved.spendingProfile?.rawValue
                    : key == "defaultSpendingCategoryId"
                        ? saved.defaultSpendingCategoryId : saved.spendingCategoryId
                guard saved.entity.rawValue == review.entity.rawValue, saved.entityId == review.entityId,
                    savedValue == value
                else { throw ReviewError.unexpectedAcceptance }
                editor.acknowledgeSavedField(key, value: .string(value), reviewedDraftValue: reviewedDraft)
                response = nil
                return .saved(field: key, value: .string(value))
            } catch {
                if scope.accepts(ticket) { response = nil }
                throw error
            }
        }
        editor.draft[key] = .string(value)
        editor.markEdited(key)
        dismissed.insert(key)
        return .draft
    }

    public var reviewedFinanceFields: [String] {
        let keys = fields.compactMap { field in proposal(field.key)?.financeReview == nil ? nil : field.key }
        guard let first = keys.first, let review = proposal(first)?.financeReview,
            keys.allSatisfy({ proposal($0)?.financeReview?.fingerprint == review.fingerprint })
        else { return [] }
        return keys
    }

    public func applyReviewedFields() async throws -> [Acceptance] {
        let keys = reviewedFinanceFields
        guard !isApplying, keys.count > 1, let first = keys.first,
            let review = proposal(first)?.financeReview, let ticket
        else { return [] }
        let values = Dictionary(
            uniqueKeysWithValues: keys.compactMap { key in proposal(key)?.value.map { (key, $0) } })
        let drafts = Dictionary(uniqueKeysWithValues: keys.map { ($0, currentValue($0)) })
        isApplying = true
        defer { isApplying = false }
        let saved = try await saveCategory(
            .init(
                entity: .init(rawValue: review.entity.rawValue)!, entityId: review.entityId,
                fingerprint: review.fingerprint, spendingCategoryId: values["spendingCategoryId"],
                defaultSpendingCategoryId: values["defaultSpendingCategoryId"],
                spendingProfile: values["spendingProfile"].flatMap { .init(rawValue: $0) }))
        guard scope.accepts(ticket), saved.entity.rawValue == review.entity.rawValue,
            saved.entityId == review.entityId
        else { throw ReviewError.unexpectedAcceptance }
        let savedValues = [
            "spendingCategoryId": saved.spendingCategoryId,
            "defaultSpendingCategoryId": saved.defaultSpendingCategoryId,
            "spendingProfile": saved.spendingProfile?.rawValue,
        ]
        var accepted: [Acceptance] = []
        for key in keys {
            guard let value = values[key], savedValues[key] == value else {
                throw ReviewError.unexpectedAcceptance
            }
            editor.acknowledgeSavedField(key, value: .string(value), reviewedDraftValue: drafts[key] ?? .null)
            accepted.append(.saved(field: key, value: .string(value)))
        }
        response = nil
        return accepted
    }

    public func dismiss(_ key: String) { dismissed.insert(key) }

    public func invalidate() {
        scope.invalidate()
        response = nil
    }

    private enum ReviewError: LocalizedError {
        case unexpectedAcceptance
        var errorDescription: String? {
            "The saved category response does not match the reviewed record and category."
        }
    }
}
