import ArgumentParser
import CubbyKit
import Foundation

/// Drives the shared statement preview and reviewed commit through generated OpenAPI calls.
struct HeadlessStatementCsvImport: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "headless-statement-csv-import")

    @Option(name: .customLong("base-url")) var baseURLString: String
    @Option(name: .customLong("file"), help: "Synthetic UTF-8 statement CSV path.")
    var filePath: String
    @Option(name: .customLong("mapping-file"), help: "Optional column mapping JSON path.")
    var mappingFile: String?
    @Option(name: .customLong("preview-offset")) var previewOffset: Int = 0
    @Option(
        name: .customLong("review-file"),
        help: "Reviewed StatementCsvCommitInput JSON bound to this exact CSV and mapping."
    )
    var reviewFile: String?

    func run() async throws {
        try await CLI.run {
            do {
                let fileURL = URL(fileURLWithPath: filePath)
                var input = try StatementCsvReviewSession.fileInput(
                    fileName: fileURL.lastPathComponent, contents: Data(contentsOf: fileURL),
                    previewOffset: previewOffset)
                if let mappingFile { input.mapping = try decodeJSON(at: mappingFile) }
                let session = await StatementCsvReviewSession(input: input)
                let reviewed: StatementCsvCommitInput?
                if let reviewFile {
                    let value: StatementCsvCommitInput = try decodeJSON(at: reviewFile)
                    _ = try await session.validatedReview(value)
                    reviewed = value
                } else {
                    reviewed = nil
                }

                let context = try await CLI.fixtureContext(baseURLString: baseURLString)
                let preview = try await session.prepare(using: context.client)
                if let reviewed {
                    try printJSON(await session.commit(reviewed: reviewed, using: context.client))
                } else {
                    try printJSON(preview)
                }
            } catch let error as StatementCsvReviewError {
                throw CLIError.message(error.localizedDescription)
            }
        }
    }

    private func decodeJSON<Value: Decodable>(at path: String) throws -> Value {
        try JSONDecoder().decode(Value.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }

    private func printJSON(_ value: some Encodable) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        print(String(decoding: try encoder.encode(value), as: UTF8.self))
    }
}
