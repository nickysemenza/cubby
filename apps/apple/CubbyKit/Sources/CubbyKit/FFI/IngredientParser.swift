import CubbyFFI

/// Cubby's Rust ingredient parser, the same code the web app runs as WASM, reached through
/// UniFFI. The wrappers in this folder are the only files that name the generated `CubbyFFI`
/// types, so a regenerated binding changes only them.
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
            amounts: parsed.amounts.map(Amount.init),
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

// An extension, so `Amount` keeps its memberwise initializer.
extension IngredientParser.Amount {
    init(_ ffi: CubbyFFI.Amount) {
        self.init(value: ffi.value, upperValue: ffi.upperValue, unit: ffi.unit)
    }

    var ffi: CubbyFFI.Amount {
        CubbyFFI.Amount(unit: unit, value: value, upperValue: upperValue)
    }
}

/// The scan-code arithmetic the device still does offline, from the same Rust the server runs
/// (`recipebridge/src/isbn.rs`): only identity, never classification — the server decides what a
/// raw scan means.
public enum ScanCodes {
    /// The GTIN-14 a barcode or ISBN is stored as (`0` + ISBN-13 for a book), or `nil` when the
    /// value is neither. A UPC-A read and its EAN-13 spelling land on the same key.
    public static func gtin14(_ raw: String) -> String? {
        CubbyFFI.scanCodeGtin14(raw: raw)
    }

    public static func isbnFromGtin(_ canonical: String) -> String? {
        CubbyFFI.isbnFromGtin(value: canonical)?.isbn13
    }

    public static func normalizeISBN(_ raw: String) -> NormalizedIsbn? {
        CubbyFFI.normalizeIsbn(value: raw)
    }
}
