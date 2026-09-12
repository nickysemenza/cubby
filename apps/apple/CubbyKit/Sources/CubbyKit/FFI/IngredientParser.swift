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
        /// The parser's own "2 cups flour" rendering. Formatting lives in Rust, never here.
        public let display: String
    }

    /// Infallible, like the Rust function: an unparseable line comes back name-only.
    public static func parse(_ line: String) -> Parsed {
        let parsed = CubbyFFI.parseIngredient(line: line)
        return Parsed(
            name: parsed.name,
            amounts: parsed.amounts.map { Amount(value: $0.value, upperValue: $0.upperValue, unit: $0.unit) },
            modifier: parsed.modifier,
            optional: parsed.optional,
            display: parsed.display
        )
    }

    /// Every unit spelling that resolves to a weight or volume, longest first. Never hand-list
    /// unit spellings elsewhere; this is the vocabulary.
    public static var sizeUnitAliases: [String] {
        CubbyFFI.sizeUnitAliases()
    }
}
