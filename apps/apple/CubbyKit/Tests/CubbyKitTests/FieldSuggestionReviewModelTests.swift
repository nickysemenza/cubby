import Foundation
import Testing

@testable import CubbyKit

@MainActor
private final class SuggestionApplyGate {
    private var continuation: CheckedContinuation<FinanceCategoryApplyOut, Never>?

    func wait() async -> FinanceCategoryApplyOut {
        await withCheckedContinuation { continuation = $0 }
    }

    func waitUntilRequested() async {
        while continuation == nil { await Task.yield() }
    }

    func complete() {
        continuation?.resume(
            returning: .init(
                entity: .expense, entityId: "EXP-4K7M", spendingCategoryId: "SPC-4K7M", sideEffects: .init()))
        continuation = nil
    }
}

/// Transport is the external seam; the real editor and review state handle delayed responses and explicit acceptance.
@Suite("Field suggestion review model")
@MainActor
struct FieldSuggestionReviewModelTests {
    private func editor(_ key: EntityKey = .expense) -> GenericEntityEditModel {
        GenericEntityEditModel(
            descriptor: EntityCatalog[key], mode: .update(id: key == .expense ? "EXP-4K7M" : "PUR-4K7M"),
            client: CubbyClient(
                baseURL: URL(string: "http://localhost:3000")!,
                credentials: CredentialProvider(host: "localhost:3000", store: InMemorySessionTokenStore())),
            original: ["spendingCategoryId": .null, "evidenceExpectation": .null, "notes": "Saved note"])
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
                #"{"suggestions":[{"field":"spendingCategoryId","suggestion":{"value":"SPC-4K7M","label":"Fixture clothing","detail":null,"confidence":"high","probability":0.96,"reasoning":"Saved linked shirt","alternatives":[],"operation":"set","removals":[]\#(review)}},{"field":"evidenceExpectation","suggestion":{"value":"not_expected","label":"Not expected","detail":null,"confidence":"high","probability":0.96,"reasoning":"Fixture restaurant","alternatives":[],"operation":"set","removals":[]}},{"field":"productExpectation","suggestion":null}]}"#
                    .utf8))
    }

    @Test func nullProposalAndInferenceDoNotWriteAndPolicyAcceptanceOnlyChangesDraft() async throws {
        let editor = editor(.purchase)
        let response = try response(finance: false)
        let initial = editor.draft
        let review = FieldSuggestionReviewModel(
            editor: editor, fetch: { _ in response },
            saveCategory: { _ in
                Issue.record("Policy acceptance must use ordinary editor Save")
                throw CancellationError()
            })
        try await review.request()
        #expect(editor.draft == initial)
        #expect(review.proposal("productExpectation") == nil)
        #expect(try await review.apply("evidenceExpectation") == .draft)
        #expect(editor.draft["evidenceExpectation"] == .string("not_expected"))
        #expect(editor.original?["evidenceExpectation"] == .null)
    }

    @Test func delayedSavedCategoryPreservesNewerCategoryAndSiblingDraft() async throws {
        let editor = editor()
        let response = try response()
        let gate = SuggestionApplyGate()
        let review = FieldSuggestionReviewModel(
            editor: editor, fetch: { _ in response }, saveCategory: { _ in await gate.wait() })
        try await review.request()
        let apply = Task { try await review.apply("spendingCategoryId") }
        await gate.waitUntilRequested()
        editor.draft["notes"] = .string("Unsaved sibling")
        editor.draft["spendingCategoryId"] = .string("SPC-8K7M")
        gate.complete()
        #expect(try await apply.value == .saved(field: "spendingCategoryId", value: .string("SPC-4K7M")))
        #expect(editor.original?["spendingCategoryId"] == .string("SPC-4K7M"))
        #expect(editor.draft["spendingCategoryId"] == .string("SPC-8K7M"))
        #expect(try editor.patch().values["notes"] == .string("Unsaved sibling"))
    }

    @Test func leavingEditorRejectsLateApplyAndStaleFailureClearsReview() async throws {
        let editor = editor()
        let response = try response()
        let gate = SuggestionApplyGate()
        let review = FieldSuggestionReviewModel(
            editor: editor, fetch: { _ in response }, saveCategory: { _ in await gate.wait() })
        try await review.request()
        let apply = Task { try await review.apply("spendingCategoryId") }
        await gate.waitUntilRequested()
        review.invalidate()
        gate.complete()
        #expect(try await apply.value == nil)
        #expect(editor.original?["spendingCategoryId"] == .null)

        let stale = FieldSuggestionReviewModel(
            editor: editor, fetch: { _ in response }, saveCategory: { _ in throw CancellationError() })
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
                    "purchaseId": purchase.stored, "evidenceExpectation": .null, "notes": "Saved note",
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
                saveCategory: { _ in throw CancellationError() })
            try await review.request()
            #expect(review.proposal("evidenceExpectation") != nil)
            editor.draft["purchaseId"] = .string("PUR-9K7M")
            #expect(review.proposal("evidenceExpectation") == nil)
        }
        #expect(masks == [[], ["purchaseId"], ["purchaseId"]])
    }
}
