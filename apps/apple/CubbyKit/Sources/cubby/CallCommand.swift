import ArgumentParser
import CubbyKit
import Foundation

/// Calls any operation in the generated catalog by id — the escape hatch for anything the
/// typed `CubbyClient` doesn't wrap.
struct Call: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Call any operation by id.")

    @OptionGroup var global: GlobalOptions

    @Argument(help: "Operation id, e.g. entity.list, upc.lookup.")
    var operationID: String = ""

    @Flag(name: .customLong("list"), help: "Print every operation id and exit.")
    var listOperations = false

    @Option(name: .customLong("json-body"), help: "JSON request body, e.g. '{\"upc\":\"012345678905\"}'.")
    var jsonBodyString: String?

    func run() async throws {
        if listOperations {
            for id in OperationCatalog.all.sorted() {
                print(id)
            }
            return
        }
        guard OperationCatalog.all.contains(operationID) else {
            CLI.printError("Unknown operationId: \(operationID) (use --list to print every id)")
            throw ExitCode.failure
        }

        try await CLI.run {
            // `CubbyClient` wraps every operation the app needs; `CubbyDebugClient` is the
            // loosely-typed escape hatch this command exists for — it shares the same credential
            // provider and `CubbyAPIError` handling, so the two behave identically on failure.
            let context = try CLIContext.make(from: global)
            let debugClient = CubbyDebugClient(
                baseURL: context.baseURL, credentials: context.credentials, identity: context.identity)
            let body = try Self.parseBody(jsonBodyString)

            let data = try await debugClient.call(
                operationID: operationID,
                input: body,
                nullInput: body == nil && OperationCatalog.nullInput.contains(operationID))
            if let json = try? JSONDecoder().decode(JSONValue.self, from: data) {
                print(try CLI.prettyJSON(json))
            } else {
                print(String(decoding: data, as: UTF8.self))
            }
        }
    }

    private static func parseBody(_ jsonBodyString: String?) throws -> Data? {
        guard let jsonBodyString else { return nil }
        guard let data = jsonBodyString.data(using: .utf8) else {
            throw CLIError.message("--json-body is not valid UTF-8.")
        }
        do {
            // Validated, not decoded: `CubbyDebugClient.call` sends the raw bytes on.
            _ = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw CLIError.message("--json-body is not valid JSON: \(error)")
        }
        return data
    }
}
