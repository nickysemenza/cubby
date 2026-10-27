/// The display formats a catalog field renders identically on web and native: fixed en-US shapes,
/// independent of the device locale, pinned by `packages/shared/golden-vectors/display-format.json`.
/// Every rule comes from the Rust implementation the web also calls (`ValueFormat`). Plain dates
/// are calendar components, without zone conversion. Change the vector first, then Rust.
public enum DisplayFormat {
    /// `currency` and `signedCurrency`: USD with grouping and cents (`-$5.00`). The sign is never
    /// spelled `+`; the web only colours it.
    public static func currency(_ value: Double) -> String {
        ValueFormat.currency(value)
    }

    /// `plainDate`: a real `YYYY-MM-DD` day as `MMM d, yyyy`; anything else comes back unchanged.
    public static func plainDate(_ value: String) -> String {
        ValueFormat.plainDate(value)
    }

    public static func text(_ value: String?, emptyLabel: String? = nil, detail: Bool = false) -> String {
        ValueFormat.text(value, emptyLabel: emptyLabel, detail: detail)
    }

    /// A bare numeric field: the shortest round-trip decimal, no grouping and no rounding — what
    /// the web prints for a raw JS number.
    public static func number(_ value: Double) -> String {
        ValueFormat.number(value)
    }

    public enum EstimateUnit: Sendable {
        case kcal
        case macro

        fileprivate var format: ValueFormat.CompactUnit { self == .kcal ? .kcal : .macro }
    }

    /// The one-line macro/cost cell: kcal rounds half-up to a whole number, a macro to one
    /// decimal, both grouped; a range joins with an en dash, a partial estimate ends in `+`, and
    /// anything unavailable or pending is `—`.
    public static func compactEstimate(_ estimate: MeasureEstimate, unit: EstimateUnit) -> String {
        guard let figure = figure(estimate) else { return "Unsupported estimate" }
        return ValueFormat.compactEstimate(figure, unit: unit.format)
    }

    /// The long form for detail text and accessibility, the web's `formatEstimate`: the figure or
    /// range, `unit` once, then its confidence (`420 kcal known · partial`, `Pending`, `N/A`).
    public static func estimate(
        _ estimate: MeasureEstimate, measure: ValueFormat.EstimateMeasure, unit: String? = nil
    ) -> String {
        guard let figure = figure(estimate) else { return "Unsupported estimate" }
        return ValueFormat.estimate(figure, measure: measure, unit: unit)
    }

    private static func figure(_ estimate: MeasureEstimate) -> ValueFormat.Estimate? {
        switch estimate {
        case .complete(let known):
            .complete(lower: known.lower, upper: known.upper, inferredZero: known.coverage.inferredZero ?? 0)
        case .partial(let known):
            .partial(lower: known.lower, upper: known.upper, inferredZero: known.coverage.inferredZero ?? 0)
        case .unavailable: .unavailable(notApplicable: estimate.isNotApplicable)
        case .pending: .pending
        case .unrecognized: nil
        }
    }
}
