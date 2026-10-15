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
    private var acceptedAssessments: [String: (id: String, value: String)] = [:]
    private let runKey = UUID().uuidString
    private let reviewAssessment: (AssessmentReviewInput) async throws -> AssessmentReviewOut
    private let fetch: (FieldSuggestionsInput) async throws -> FieldSuggestionsReviewOut
    private let saveCategory: (FinanceCategoryApplyInput) async throws -> FinanceCategoryApplyOut

    public init(
        editor: GenericEntityEditModel,
        fetch: @escaping (FieldSuggestionsInput) async throws -> FieldSuggestionsReviewOut,
        saveCategory: @escaping (FinanceCategoryApplyInput) async throws -> FinanceCategoryApplyOut,
        reviewAssessment: @escaping (AssessmentReviewInput) async throws -> AssessmentReviewOut
    ) {
        self.editor = editor
        self.fetch = fetch
        self.saveCategory = saveCategory
        self.reviewAssessment = reviewAssessment
    }

    public var fields: [FieldDescriptor] {
        editor.visibleFields.filter {
            $0.suggestion != nil && ($0.suggestion?.mode ?? "fill") == "fill"
                && $0.reference?.multiple != true
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
                try await recordDraftAcceptance(assessmentId: proposed.assessmentId)
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
                try await recordApplication(
                    key, value: value, recordId: saved.entityId, assessmentId: proposed.assessmentId)
                response = nil
                return .saved(field: key, value: .string(value))
            } catch {
                if scope.accepts(ticket) { response = nil }
                throw error
            }
        }
        guard let assessmentId = proposed.assessmentId else { throw ReviewError.missingAssessment }
        try await recordDraftAcceptance(assessmentId: assessmentId)
        editor.draft[key] = .string(value)
        editor.markEdited(key)
        acceptedAssessments[key] = (assessmentId, value)
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
        let assessmentIds = Dictionary(uniqueKeysWithValues: keys.map { ($0, proposal($0)?.assessmentId) })
        isApplying = true
        defer { isApplying = false }
        for key in keys {
            try await recordDraftAcceptance(assessmentId: proposal(key)?.assessmentId)
        }
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
            try await recordApplication(
                key, value: value, recordId: saved.entityId, assessmentId: assessmentIds[key] ?? nil)
            accepted.append(.saved(field: key, value: .string(value)))
        }
        response = nil
        return accepted
    }

    public func dismiss(_ key: String) async throws {
        guard let assessmentId = proposal(key)?.assessmentId else { throw ReviewError.missingAssessment }
        _ = try await reviewAssessment(
            .init(
                operationId: UUID().uuidString, verdict: .wrong,
                correction: .AssessmentCorrectionFalse(.init(present: false)),
                intent: .history, assessmentId: assessmentId))
        dismissed.insert(key)
    }

    /// Receipt follows the editor's confirmed save and only names a field that still has
    /// the value explicitly accepted in this draft.
    public func recordSavedApplications(recordId: String) async throws {
        for key in acceptedAssessments.keys.sorted() {
            guard let accepted = acceptedAssessments[key],
                currentValue(key) == .string(accepted.value)
            else { continue }
            try await recordApplication(key, value: accepted.value, recordId: recordId)
        }
    }

    private func recordApplication(
        _ key: String, value: String, recordId: String, assessmentId: String? = nil
    ) async throws {
        guard let accepted = acceptedAssessments[key] else {
            // Immediate finance application is explicit and has not entered the draft map.
            guard let assessmentId = assessmentId ?? proposal(key)?.assessmentId else {
                throw ReviewError.missingAssessment
            }
            let receipt = try await reviewAssessment(
                .init(
                    operationId: UUID().uuidString, verdict: .correct,
                    correction: .AssessmentCorrectionFalse(.init(present: false)),
                    intent: .apply, assessmentId: assessmentId,
                    application: .savedField(.init(kind: .savedField, recordId: recordId))))
            guard receipt.applied else { throw ReviewError.unexpectedAcceptance }
            return
        }
        guard accepted.value == value else { return }
        let receipt = try await reviewAssessment(
            .init(
                operationId: UUID().uuidString, verdict: .correct,
                correction: .AssessmentCorrectionFalse(.init(present: false)),
                intent: .apply, assessmentId: accepted.id,
                application: .savedField(.init(kind: .savedField, recordId: recordId))))
        guard receipt.applied else { throw ReviewError.unexpectedAcceptance }
        if acceptedAssessments[key]?.id == accepted.id, acceptedAssessments[key]?.value == accepted.value {
            acceptedAssessments.removeValue(forKey: key)
        }
    }

    private func recordDraftAcceptance(assessmentId: String?) async throws {
        guard let assessmentId else { throw ReviewError.missingAssessment }
        _ = try await reviewAssessment(
            .init(
                operationId: UUID().uuidString, verdict: .correct,
                correction: .AssessmentCorrectionFalse(.init(present: false)),
                intent: .draft, assessmentId: assessmentId))
    }

    public func invalidate() {
        scope.invalidate()
        response = nil
    }

    private enum ReviewError: LocalizedError {
        case unexpectedAcceptance
        case missingAssessment
        var errorDescription: String? {
            switch self {
            case .unexpectedAcceptance: "The saved response does not match the reviewed suggestion."
            case .missingAssessment: "The field suggestion is missing its assessment."
            }
        }
    }
}
