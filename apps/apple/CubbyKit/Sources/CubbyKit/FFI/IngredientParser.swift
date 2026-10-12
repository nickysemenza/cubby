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

/// The scan-code arithmetic the device still does offline, from the same Rust the server runs
/// (`recipebridge/src/isbn.rs`): only identity, never classification — the server decides what a
/// raw scan means.
public enum ScanCodes {
    /// The GTIN-14 a barcode or ISBN is stored as (`0` + ISBN-13 for a book), or `nil` when the
    /// value is neither. A UPC-A read and its EAN-13 spelling land on the same key.
    public static func gtin14(_ raw: String) -> String? {
        CubbyFFI.scanCodeGtin14(raw: raw)
    }

    public static func normalizeISBN(_ raw: String) -> NormalizedIsbn? {
        CubbyFFI.normalizeIsbn(value: raw)
    }
}

/// The value formats web and native print identically, from the Rust the web calls as WASM
/// (`recipebridge/src/display_format.rs`; pinned by `golden-vectors/display-format.json`). Swift
/// never formats a currency, bare number, amount, or nutrition estimate itself.
public enum ValueFormat {
    public enum CompactUnit: Sendable {
        case kcal
        case macro

        fileprivate var ffi: CubbyFFI.CompactUnit {
            switch self {
            case .kcal: .kcal
            case .macro: .macro
            }
        }
    }

    /// USD, en-US, half away from zero (`-$5.00`).
    public static func currency(_ value: Double, minFractionDigits: UInt32 = 2, maxFractionDigits: UInt32 = 2)
        -> String
    {
        CubbyFFI.formatCurrency(
            value: value, minFractionDigits: minFractionDigits, maxFractionDigits: maxFractionDigits)
    }

    /// The shortest round-trip decimal, no grouping.
    public static func number(_ value: Double) -> String {
        CubbyFFI.formatNumber(value: value)
    }

    /// `2 cups`, `3 each`, `2 - 3 tsp`; a missing unit renders a bare count (`1.5`).
    public static func amount(unit: String?, value: Double, upperValue: Double? = nil) -> String {
        CubbyFFI.formatAmount(unit: unit ?? "", value: value, upperValue: upperValue)
    }

    /// Which number rule a long-form estimate label uses.
    public enum EstimateMeasure: Sendable {
        /// USD with cents.
        case cost
        /// Whole and grouped.
        case kcal
        /// One decimal, grouped, a trailing `.0` dropped.
        case macro
        /// A fraction printed as a one-decimal percent.
        case share

        fileprivate var ffi: CubbyFFI.EstimateMeasure {
            switch self {
            case .cost: .cost
            case .kcal: .kcal
            case .macro: .macro
            case .share: .share
            }
        }
    }

    /// A nutrition/cost estimate as the formatters read it: a known figure (complete or partial,
    /// with how many contributors were inferred zero), unavailable, or pending.
    public enum Estimate: Sendable {
        case complete(lower: Double, upper: Double?, inferredZero: Int)
        case partial(lower: Double, upper: Double?, inferredZero: Int)
        case unavailable(notApplicable: Bool)
        case pending

        fileprivate var ffi: EstimateFigure {
            switch self {
            case .complete(let lower, let upper, let inferredZero):
                .complete(lower: lower, upper: upper, inferredZero: UInt32(inferredZero))
            case .partial(let lower, let upper, let inferredZero):
                .partial(lower: lower, upper: upper, inferredZero: UInt32(inferredZero))
            case .unavailable(let notApplicable): .unavailable(notApplicable: notApplicable)
            case .pending: .pending
            }
        }
    }

    /// The one-line cell: a partial figure ends in `+`; unavailable or pending is `—`.
    public static func compactEstimate(_ estimate: Estimate, unit: CompactUnit) -> String {
        CubbyFFI.formatCompactEstimate(figure: estimate.ffi, unit: unit.ffi)
    }

    /// The long form for detail text and accessibility (`1,500–2,250 kcal known · partial`,
    /// `Pending`, `N/A`): `unit` prints once after the figure or range.
    public static func estimate(_ estimate: Estimate, measure: EstimateMeasure, unit: String? = nil)
        -> String
    {
        CubbyFFI.formatEstimate(figure: estimate.ffi, measure: measure.ffi, unit: unit)
    }
}
