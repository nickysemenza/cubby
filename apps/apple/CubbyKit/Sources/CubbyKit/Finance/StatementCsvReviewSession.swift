import Foundation
import Observation

public enum StatementCsvReviewError: LocalizedError, Equatable {
    case invalidFile
    case invalidOffset
    case noFile
    case noPreview
    case needsMapping
    case reviewDoesNotMatch

    public var errorDescription: String? {
        switch self {
        case .invalidFile: "Choose a nonempty UTF-8 CSV smaller than 5 MB"
        case .invalidOffset: "Statement preview offset must be nonnegative"
        case .noFile: "Choose a statement CSV before reviewing rows"
        case .noPreview: "Preview the statement CSV before confirming the import"
        case .needsMapping: "Map the CSV columns before confirming the import"
        case .reviewDoesNotMatch: "Review must name this exact CSV file, bytes, and mapping"
        }
    }
}

/// Client review state is bound to the previewed input; row eligibility and reconciliation stay server-owned.
@MainActor
@Observable
public final class StatementCsvReviewSession {
    public private(set) var input: StatementCsvFileInput?
    public private(set) var preview: StatementCsvPreviewOut?
    public private(set) var reviewRows: [FinancialStatementImportPreviewRow] = []
    public private(set) var result: StatementCsvCommitOut?
    public var selected = Set<String>()
    public var kinds: [String: FinancialTransactionKind] = [:]
    public var attachments: [String: String] = [:]
    private var revision = 0

    public init(input: StatementCsvFileInput? = nil) {
        self.input = input
    }

    nonisolated public static func fileInput(
        fileName: String, contents: Data, previewOffset: Int = 0
    ) throws -> StatementCsvFileInput {
        guard previewOffset >= 0 else { throw StatementCsvReviewError.invalidOffset }
        guard !contents.isEmpty, contents.count <= 5_000_000,
            String(data: contents, encoding: .utf8) != nil
        else { throw StatementCsvReviewError.invalidFile }
        // Swift's UTF-8 decoder preserves the bytes, including a file's optional BOM.
        return .init(
            fileName: fileName, text: String(decoding: contents, as: UTF8.self), previewOffset: previewOffset)
    }

    public func replaceInput(_ next: StatementCsvFileInput?) {
        revision += 1
        input = next
        preview = nil
        reviewRows = []
        result = nil
        clearDecisions()
    }

    public func prepare(
        _ next: StatementCsvFileInput? = nil, using client: CubbyClient
    ) async throws -> StatementCsvPreviewOut {
        guard let request = next ?? input else { throw StatementCsvReviewError.noFile }
        let ticket = revision
        let value = try await client.previewStatementCsv(request)
        guard ticket == revision else { return value }
        if next != nil { replaceInput(request) }
        preview = value
        reviewRows = value.preview?.rows ?? []
        return value
    }

    public func loadMore(using client: CubbyClient) async throws {
        guard let preview, preview.hasMore, var request = input else { return }
        let ticket = revision
        request.previewOffset = preview.previewOffset + (preview.preview?.rows.count ?? 0)
        let next = try await client.previewStatementCsv(request)
        guard ticket == revision else { return }
        reviewRows.append(contentsOf: next.preview?.rows ?? [])
        self.preview = next
    }

    public var hasUnresolvedAttachment: Bool {
        reviewRows.contains { row in
            row.status == .possibleExisting && selected.contains(row.key)
                && (attachments[row.key] ?? "").isEmpty
        }
    }

    public func reviewedInput() throws -> StatementCsvCommitInput {
        guard let input else { throw StatementCsvReviewError.noFile }
        let choices: StatementCsvCommitInput.SelectedPayload = selected.sorted().map { key in
            if let transactionId = attachments[key], !transactionId.isEmpty {
                return .init(key: key, transactionId: transactionId)
            }
            // A missing decision remains explicit so the backend can refuse it; never silently drop a selected row.
            return .init(key: key, kind: kinds[key])
        }
        var reviewed = StatementCsvCommitInput(
            fileName: input.fileName, text: input.text, selected: choices)
        reviewed.mapping = input.mapping
        return reviewed
    }

    public func validatedReview(_ reviewed: StatementCsvCommitInput) throws -> StatementCsvCommitInput {
        guard let input else { throw StatementCsvReviewError.noFile }
        guard reviewed.fileName == input.fileName,
            Data(reviewed.text.utf8) == Data(input.text.utf8),
            reviewed.mapping == input.mapping
        else { throw StatementCsvReviewError.reviewDoesNotMatch }
        return reviewed
    }

    @discardableResult
    public func commit(
        reviewed: StatementCsvCommitInput? = nil, using client: CubbyClient
    ) async throws -> StatementCsvCommitOut {
        guard let preview else { throw StatementCsvReviewError.noPreview }
        guard !preview.needsMapping else { throw StatementCsvReviewError.needsMapping }
        let request = try validatedReview(reviewed ?? reviewedInput())
        let ticket = revision
        let committed = try await client.commitStatementCsv(request)
        if ticket == revision {
            result = committed
            clearDecisions()
        }
        return committed
    }

    private func clearDecisions() {
        selected = []
        kinds = [:]
        attachments = [:]
    }
}
