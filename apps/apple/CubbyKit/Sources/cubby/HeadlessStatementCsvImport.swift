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
            guard
                let baseURL = URL(string: baseURLString),
                baseURL.scheme == "http", baseURL.host() == "127.0.0.1",
                baseURL.port != nil, baseURL.user() == nil, baseURL.password() == nil,
                baseURL.path().isEmpty || baseURL.path() == "/"
            else {
                throw CLIError.message("Headless statement import requires a loopback HTTP server")
            }
            guard previewOffset >= 0 else {
                throw CLIError.message("Statement preview offset must be nonnegative")
            }
            let fileURL = URL(fileURLWithPath: filePath)
            let data = try Data(contentsOf: fileURL)
            guard data.count <= 5_000_000, !data.isEmpty,
                let text = String(data: data, encoding: .utf8)
            else {
                throw CLIError.message("Choose a nonempty UTF-8 CSV smaller than 5 MB")
            }
            var input = StatementCsvFileInput(
                fileName: fileURL.lastPathComponent, text: text, previewOffset: previewOffset)
            if let mappingFile {
                input.mapping = try decodeJSON(at: mappingFile)
            }
            let reviewed: StatementCsvCommitInput?
            if let reviewFile {
                let value: StatementCsvCommitInput = try decodeJSON(at: reviewFile)
                guard value.fileName == input.fileName,
                    Data(value.text.utf8) == data,
                    value.mapping == input.mapping
                else {
                    throw CLIError.message("Review must name this exact CSV file, bytes, and mapping")
                }
                reviewed = value
            } else {
                reviewed = nil
            }

            let credentials = CredentialProvider(
                host: CubbyBaseURL.host(of: baseURL), store: InMemorySessionTokenStore())
            let identity = ClientIdentity.currentApp(product: "cubby-cli", installationID: nil)
            let auth = AuthFlow(baseURL: baseURL, credentials: credentials, identity: identity)
            _ = try await auth.signIn(
                email: "sim@cubby.localhost", password: "cubby-sim-local-only")
            let client = CubbyClient(
                baseURL: baseURL, credentials: credentials, identity: identity)
            let preview = try await client.previewStatementCsv(input)
            if let reviewed {
                // The backend previews again and validates every selected key and attachment.
                guard !preview.needsMapping else {
                    throw CLIError.message("Map the CSV columns before confirming the import")
                }
                try printJSON(await client.commitStatementCsv(reviewed))
            } else {
                try printJSON(preview)
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
