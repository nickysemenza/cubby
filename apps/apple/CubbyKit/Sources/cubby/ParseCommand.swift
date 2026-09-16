import ArgumentParser
import CubbyKit

/// Runs Cubby's Rust ingredient parser through the UniFFI bridge. No network, no auth: this is
/// the smoke test that the xcframework links and the bindings round-trip.
struct Parse: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        abstract: "Parse an ingredient line with the Rust parser (FFI smoke test).")

    @Flag(help: "Print the parsed structure as JSON.")
    var json: Bool = false
    @Flag(name: .customLong("units"), help: "Print the size-unit alias vocabulary instead.")
    var units: Bool = false
    @Flag(name: .customLong("isbn"), help: "Normalize the line as an ISBN instead (the scan-code FFI).")
    var isbn: Bool = false
    @Argument(help: "An ingredient line, e.g. \"2 cups flour\".")
    var line: [String] = []

    func run() async throws {
        if units {
            print(IngredientParser.sizeUnitAliases.joined(separator: " "))
            return
        }
        let text = line.joined(separator: " ")
        if isbn {
            guard let normalized = ScanCodes.normalizeISBN(text) else {
                throw CLIError.message("Not a valid ISBN-10 or ISBN-13.")
            }
            print("\(normalized.gtin14) isbn13=\(normalized.isbn13) isbn10=\(normalized.isbn10 ?? "-")")
            return
        }
        guard !text.isEmpty else { throw CLIError.message("Give an ingredient line to parse.") }
        let parsed = IngredientParser.parse(text)
        if json {
            let amounts: [JSONValue] = parsed.amounts.map {
                .object([
                    "value": .number($0.value),
                    "upperValue": $0.upperValue.map(JSONValue.number) ?? .null,
                    "unit": .string($0.unit),
                ])
            }
            let object: JSONValue = .object([
                "name": .string(parsed.name),
                "amounts": .array(amounts),
                "modifier": parsed.modifier.map(JSONValue.string) ?? .null,
                "optional": .bool(parsed.optional),
            ])
            print(try CLI.prettyJSON(object))
        } else {
            print(parsed.display)
        }
    }
}
