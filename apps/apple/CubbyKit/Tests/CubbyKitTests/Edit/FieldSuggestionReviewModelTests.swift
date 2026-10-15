import Foundation
import Testing

@testable import CubbyKit

/// Transport is the external seam; the real editor and review state handle delayed responses and explicit acceptance.
@Suite("Field suggestion review model", .timeLimit(.minutes(1)))
@MainActor
struct FieldSuggestionReviewModelTests {
    private func reviewOut() throws -> AssessmentReviewOut {
        try JSONDecoder().decode(
            AssessmentReviewOut.self,
            from: Data(
                #"{"assessmentId":"00000000-0000-4000-8000-000000000001","feedbackId":"00000000-0000-4000-8000-000000000002","status":"applied","applied":true}"#
                    .utf8))
    }
    private static let applied = FinanceCategoryApplyOut(
        entity: .expense, entityId: "EXP-4K7M", spendingCategoryId: "SPC-4K7M", sideEffects: .init())

    private func editor(_ key: EntityKey = .expense) -> GenericEntityEditModel {
        GenericEntityEditModel(
            descriptor: EntityCatalog[key], mode: .update(id: key == .expense ? "EXP-4K7M" : "PUR-4K7M"),
            client: CubbyClient(
                baseURL: URL(string: "http://localhost:3000")!,
                credentials: CredentialProvider(host: "localhost:3000", store: InMemorySessionTokenStore())),
            original: ["spendingCategoryId": .null, "itemizationExpectation": .null, "notes": "Saved note"])
    }

    private func response(finance: Bool = true) throws -> FieldSuggestionsReviewOut {
        let fingerprint = String(repeating: "a", count: 64)
        let review =
            finance
            ? #", "financeReview":{"entity":"expense","entityId":"EXP-4K7M","fingerprint":"\#(fingerprint)"}"#
            : ""
        return try JSONDecoder().decode(
            FieldSuggestionsReviewOut.self,
            from: Data(
                #"{"suggestions":[{"field":"spendingCategoryId","suggestion":{"assessmentId":"00000000-0000-4000-8000-000000000003","value":"SPC-4K7M","label":"Fixture clothing","detail":null,"confidence":"high","probability":0.96,"reasoning":"Saved linked shirt","alternatives":[],"operation":"set","removals":[]\#(review)}},{"field":"itemizationExpectation","suggestion":{"assessmentId":"00000000-0000-4000-8000-000000000004","value":"not_expected","label":"Not expected","detail":null,"confidence":"high","probability":0.96,"reasoning":"Fixture restaurant","alternatives":[],"operation":"set","removals":[]}},{"field":"productExpectation","suggestion":null}]}"#
                    .utf8))
    }

    @Test func nullProposalAndInferenceDoNotWriteAndPolicyAcceptanceOnlyChangesDraft() async throws {
        let editor = editor(.purchase)
        let response = try response(finance: false)
        let initial = editor.draft
        var reviews: [AssessmentReviewInput] = []
        let review = FieldSuggestionReviewModel(
            editor: editor, fetch: { _ in response },
            saveCategory: { _ in
                Issue.record("Policy acceptance must use ordinary editor Save")
                throw CancellationError()
            },
            reviewAssessment: { input in
                reviews.append(input); return try self.reviewOut()
            })
        try await review.request()
        #expect(editor.draft == initial)
        #expect(review.proposal("productExpectation") == nil)
        #expect(try await review.apply("itemizationExpectation") == .draft)
        #expect(editor.draft["itemizationExpectation"] == .string("not_expected"))
        #expect(editor.original?["itemizationExpectation"] == .null)
        #expect(reviews.count == 1)
        #expect(reviews[0].intent == .draft)
    }

    @Test func delayedSavedCategoryPreservesNewerCategoryAndSiblingDraft() async throws {
        let editor = editor()
        let response = try response()
        let gate = Gate()
        var reviews: [AssessmentReviewInput] = []
        let review = FieldSuggestionReviewModel(
            editor: editor, fetch: { _ in response },
            saveCategory: { _ in
                await gate.hold()
                return Self.applied
            },
            reviewAssessment: { input in
                reviews.append(input); return try self.reviewOut()
            })
        try await review.request()
        let apply = Task { try await review.apply("spendingCategoryId") }
        await gate.arrivals(1)
        editor.draft["notes"] = .string("Unsaved sibling")
        editor.draft["spendingCategoryId"] = .string("SPC-8K7M")
        gate.open()
        #expect(try await apply.value == .saved(field: "spendingCategoryId", value: .string("SPC-4K7M")))
        #expect(editor.original?["spendingCategoryId"] == .string("SPC-4K7M"))
        #expect(editor.draft["spendingCategoryId"] == .string("SPC-8K7M"))
        #expect(try editor.patch().values["notes"] == .string("Unsaved sibling"))
        #expect(reviews.count == 2)
        #expect(reviews[0].intent == .draft)
        #expect(reviews[1].intent == .apply)
    }

    @Test func leavingEditorRejectsLateApplyAndStaleFailureClearsReview() async throws {
        let editor = editor()
        let response = try response()
        let gate = Gate()
        let review = FieldSuggestionReviewModel(
            editor: editor, fetch: { _ in response },
            saveCategory: { _ in
                await gate.hold()
                return Self.applied
            }, reviewAssessment: { _ in try self.reviewOut() })
        try await review.request()
        let apply = Task { try await review.apply("spendingCategoryId") }
        await gate.arrivals(1)
        review.invalidate()
        gate.open()
        #expect(try await apply.value == nil)
        #expect(editor.original?["spendingCategoryId"] == .null)

        let stale = FieldSuggestionReviewModel(
            editor: editor, fetch: { _ in response }, saveCategory: { _ in throw CancellationError() },
            reviewAssessment: { _ in try self.reviewOut() })
        try await stale.request()
        await #expect(throws: CancellationError.self) { try await stale.apply("spendingCategoryId") }
        #expect(stale.proposal("spendingCategoryId") == nil)
    }

    @Test func requestCarriesDeclaredLinkValueAlongsideChangedOrClearedIntent() async throws {
        let response = try response(finance: false)
        var masks: [[String]] = []
        let cases: [(stored: JSONValue, draft: JSONValue)] = [
            (.null, .null), (.string("PUR-4K7M"), .null), (.null, .string("PUR-8K7M")),
        ]
        for purchase in cases {
            let editor = GenericEntityEditModel(
                descriptor: EntityCatalog[.financialTransaction], mode: .update(id: "FTX-4K7M"),
                client: CubbyClient(
                    baseURL: URL(string: "http://localhost:3000")!,
                    credentials: CredentialProvider(
                        host: "localhost:3000", store: InMemorySessionTokenStore())),
                original: [
                    "purchaseId": purchase.stored, "itemizationExpectation": .null, "notes": "Saved note",
                ])
            editor.draft["purchaseId"] = purchase.draft
            let review = FieldSuggestionReviewModel(
                editor: editor,
                fetch: { input in
                    let encoded = try #require(input.basis.additionalProperties["__draftFields"] ?? nil)
                    masks.append(try JSONDecoder().decode([String].self, from: Data(encoded.utf8)))
                    #expect(input.basis.additionalProperties.keys.contains("purchaseId"))
                    let basisPurchase = input.basis.additionalProperties["purchaseId"] ?? nil
                    #expect(basisPurchase == purchase.draft.stringValue)
                    return response
                },
                saveCategory: { _ in throw CancellationError() },
                reviewAssessment: { _ in try self.reviewOut() })
            try await review.request()
            #expect(review.proposal("itemizationExpectation") != nil)
            editor.draft["purchaseId"] = .string("PUR-9K7M")
            #expect(review.proposal("itemizationExpectation") == nil)
        }
        #expect(masks == [[], ["purchaseId"], ["purchaseId"]])
    }
}
