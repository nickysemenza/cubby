import CubbyFFI

/// Cubby's Rust ingredient parser, the same code the web app runs as WASM, reached through
/// UniFFI. This wrapper is the only file that names the generated `CubbyFFI` types, so a
/// regenerated binding changes one file.
public enum IngredientParser {
    public struct Amount: Sendable, Hashable {
        public let value: Double
        public let upperValue: Double?
        public let unit: String
    }

    public struct Parsed: Sendable, Hashable {
        public let name: String
        public let amounts: [Amount]
        public let modifier: String?
        public let optional: Bool

        /// "2 cups flour" style one-line summary, for the CLI and Dev screen.
        public var summary: String {
            let amount = amounts.map { a in
                let value = a.value == a.value.rounded() ? String(Int(a.value)) : String(a.value)
                let upper = a.upperValue.map { "-\($0)" } ?? ""
                return "\(value)\(upper) \(a.unit)"
            }.joined(separator: ", ")
            let modifier = modifier.map { ", \($0)" } ?? ""
            return "\(amount.isEmpty ? "" : amount + " ")\(name)\(modifier)\(optional ? " (optional)" : "")"
        }
    }

    /// Infallible, like the Rust function: an unparseable line comes back name-only.
    public static func parse(_ line: String) -> Parsed {
        let parsed = CubbyFFI.parseIngredient(line: line)
        return Parsed(
            name: parsed.name,
            amounts: parsed.amounts.map { Amount(value: $0.value, upperValue: $0.upperValue, unit: $0.unit) },
            modifier: parsed.modifier,
            optional: parsed.optional
        )
    }

    /// Every unit spelling that resolves to a weight or volume, longest first. Never hand-list
    /// unit spellings elsewhere; this is the vocabulary.
    public static var sizeUnitAliases: [String] {
        CubbyFFI.sizeUnitAliases()
    }
}
