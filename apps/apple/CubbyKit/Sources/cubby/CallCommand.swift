import ArgumentParser
import CubbyKit
import Foundation

/// Calls any operation in the generated route table by id — the escape hatch for anything the
/// typed `CubbyClient` doesn't wrap.
struct Call: AsyncParsableCommand {
    static let configuration = CommandConfiguration(abstract: "Call any operation by id.")

    @OptionGroup var global: GlobalOptions

    @Argument(help: "Operation id, e.g. resources.product.list, upc.lookup.")
    var operationID: String = ""

    @Flag(name: .customLong("list"), help: "Print every operation id and exit.")
    var listOperations = false

    @Option(name: .customLong("json-body"), help: "JSON request body, e.g. '{\"upc\":\"012345678905\"}'.")
    var jsonBodyString: String?

    @Option(name: .customLong("id"), help: "Path id, substituted for {id} in the route.")
    var pathID: String?

    @Option(name: .customLong("query"), help: "A key=value query parameter. Repeatable.")
    var query: [String] = []

    private var parsedQueryKeys: [String] {
        query.compactMap { pair in pair.firstIndex(of: "=").map { String(pair[pair.startIndex..<$0]) } }
    }

    func run() async throws {
        if listOperations {
            for id in OperationRoute.all.keys.sorted() {
                print(id)
            }
            return
        }
        guard let route = OperationRoute.all[operationID] else {
            CLI.printError("Unknown operationId: \(operationID) (use --list to print every id)")
            throw ExitCode.failure
        }
        for key in parsedQueryKeys where !route.queryParameters.contains(key) {
            CLI.printError("warning: \(operationID) declares no query parameter named \(key)")
        }

        try await CLI.run {
            let context = try CLIContext.make(from: global)
            let parsedQuery = try Self.parseQuery(query)
            let body = try Self.parseBody(jsonBodyString)

            let result = try await context.client.raw.call(route, pathID: pathID, query: parsedQuery, body: body)
            print(try CLI.prettyJSON(result))
        }
    }

    private static func parseQuery(_ pairs: [String]) throws -> [String: JSONValue] {
        var query: [String: JSONValue] = [:]
        for pair in pairs {
            guard let separator = pair.firstIndex(of: "=") else {
                throw CLIError.message("Invalid --query entry (expected key=value): \(pair)")
            }
            let key = String(pair[pair.startIndex..<separator])
            let value = String(pair[pair.index(after: separator)...])
            // A value that parses as JSON (2, true, null, {…}, […]) is sent typed, which is what
            // numeric controls like pageSize need; anything else travels as a plain string.
            if let data = value.data(using: .utf8),
                let json = try? JSONDecoder().decode(JSONValue.self, from: data)
            {
                query[key] = json
            } else {
                query[key] = .string(value)
            }
        }
        return query
    }

    private static func parseBody(_ jsonBodyString: String?) throws -> JSONValue? {
        guard let jsonBodyString else { return nil }
        guard let data = jsonBodyString.data(using: .utf8) else {
            throw CLIError.message("--json-body is not valid UTF-8.")
        }
        do {
            return try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw CLIError.message("--json-body is not valid JSON: \(error)")
        }
    }
}
