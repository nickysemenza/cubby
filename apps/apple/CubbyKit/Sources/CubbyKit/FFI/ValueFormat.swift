import CubbyFFI

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

    public static func count(_ value: Double, maxFractionDigits: UInt32 = 0) -> String {
        CubbyFFI.formatCount(value: value, maxFractionDigits: maxFractionDigits)
    }

    public static func plainDate(_ value: String) -> String {
        CubbyFFI.formatPlainDate(value: value)
    }

    public static func text(_ value: String?, emptyLabel: String? = nil, detail: Bool = false) -> String {
        CubbyFFI.formatText(value: value, emptyLabel: emptyLabel, detail: detail)
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

    /// `count` for an integer count of records or items.
    public static func count(_ value: Int) -> String { count(Double(value)) }

    /// The one-line cell for a server estimate; an unrecognized variant is unsupported.
    public static func compactEstimate(_ estimate: MeasureEstimate, unit: CompactUnit) -> String {
        guard let figure = Estimate(estimate) else { return "Unsupported estimate" }
        return compactEstimate(figure, unit: unit)
    }

    /// The long form for a server estimate (`420 kcal known · partial`, `Pending`, `N/A`).
    public static func estimate(_ estimate: MeasureEstimate, measure: EstimateMeasure, unit: String? = nil)
        -> String
    {
        guard let figure = Estimate(estimate) else { return "Unsupported estimate" }
        return self.estimate(figure, measure: measure, unit: unit)
    }
}

extension ValueFormat.Estimate {
    fileprivate init?(_ estimate: MeasureEstimate) {
        switch estimate {
        case .complete(let known):
            self = .complete(
                lower: known.lower, upper: known.upper, inferredZero: known.coverage.inferredZero ?? 0)
        case .partial(let known):
            self = .partial(
                lower: known.lower, upper: known.upper, inferredZero: known.coverage.inferredZero ?? 0)
        case .unavailable: self = .unavailable(notApplicable: estimate.isNotApplicable)
        case .pending: self = .pending
        case .unrecognized: return nil
        }
    }
}
