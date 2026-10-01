import Foundation
import Testing

@testable import CubbyKit

@Suite("Statement CSV review session")
@MainActor
struct StatementCsvReviewSessionTests {
    @Test func reviewRequiresExactBytesEvenWhenSwiftStringsCompareEqual() throws {
        let text = "Date,Amount,Description\n2026-09-10,-23,Cafe\u{301}\n"
        let input = try StatementCsvReviewSession.fileInput(
            fileName: "synthetic.csv", contents: Data(text.utf8))
        let session = StatementCsvReviewSession(input: input)
        var reviewed = StatementCsvCommitInput(
            fileName: input.fileName, text: input.text, selected: [])
        #expect(try session.validatedReview(reviewed) == reviewed)
        reviewed.text = "Date,Amount,Description\n2026-09-10,-23,Caf\u{e9}\n"
        #expect(reviewed.text == text)
        #expect(throws: StatementCsvReviewError.reviewDoesNotMatch) {
            try session.validatedReview(reviewed)
        }
        reviewed.text = text
        reviewed.fileName = "another.csv"
        #expect(throws: StatementCsvReviewError.reviewDoesNotMatch) {
            try session.validatedReview(reviewed)
        }
    }

    @Test func replacingTheReviewInputRevokesDraftDecisions() throws {
        let input = try StatementCsvReviewSession.fileInput(
            fileName: "synthetic.csv", contents: Data("Date,Amount\n2026-09-10,-23\n".utf8))
        let session = StatementCsvReviewSession(input: input)
        session.selected = ["synthetic-row"]
        session.kinds["synthetic-row"] = .purchase
        session.attachments["synthetic-row"] = "FTX-4K7M"
        let reviewed = try session.reviewedInput()
        let replacement = try StatementCsvReviewSession.fileInput(
            fileName: "replacement.csv", contents: Data("Date,Amount\n2026-09-11,-24\n".utf8))
        session.replaceInput(replacement)
        #expect(session.selected.isEmpty)
        #expect(session.kinds.isEmpty)
        #expect(session.attachments.isEmpty)
        #expect(throws: StatementCsvReviewError.reviewDoesNotMatch) {
            try session.validatedReview(reviewed)
        }
    }
}
