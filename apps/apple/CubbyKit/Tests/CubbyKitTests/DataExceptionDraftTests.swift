import Testing

@testable import CubbyKit

@Suite("Data exception draft")
struct DataExceptionDraftTests {
    private let draft = DataExceptionDraft(entityID: "PRD-4K7M", check: "product_manufacturer")

    @Test func blankNoteFallsBackToTheReasonLabelBecauseTheServerRequiresOne() throws {
        let input = try #require(
            draft.setInput(reason: .notApplicable, label: "Not applicable", note: "  \n"))
        #expect(input.note == "Not applicable")
        #expect(input.entityId == "PRD-4K7M")
        #expect(input.check.rawValue == "product_manufacturer")
    }

    @Test func providedNoteIsTrimmedAndKept() throws {
        let input = try #require(
            draft.setInput(reason: .unavailable, label: "Unavailable", note: " Synthetic. "))
        #expect(input.note == "Synthetic.")
    }

    @Test func unknownCheckProducesNoRequest() {
        let unknown = DataExceptionDraft(entityID: "PRD-4K7M", check: "check_from_a_later_server")
        #expect(unknown.setInput(reason: .unavailable, label: "Unavailable", note: "") == nil)
        #expect(unknown.clearInput() == nil)
        #expect(draft.clearInput()?.check.rawValue == "product_manufacturer")
    }
}
