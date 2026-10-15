import Testing

@testable import CubbyKit

@Suite("Data exception draft")
struct DataExceptionDraftTests {
    private let draft = DataExceptionDraft(entityID: "PRD-4K7M", check: "product_manufacturer")

    @Test func blankExplanationProducesNoFinding() {
        #expect(draft.setInput(reason: .unavailable, note: "  \n") == nil)
    }

    @Test func providedNoteIsTrimmedAndKept() throws {
        let input = try #require(
            draft.setInput(reason: .unavailable, note: " Synthetic. "))
        #expect(input.note == "Synthetic.")
    }

    @Test func unknownCheckProducesNoRequest() {
        let unknown = DataExceptionDraft(entityID: "PRD-4K7M", check: "check_from_a_later_server")
        #expect(unknown.setInput(reason: .unavailable, note: "") == nil)
        #expect(unknown.clearInput() == nil)
        #expect(draft.clearInput()?.check.rawValue == "product_manufacturer")
    }
}
