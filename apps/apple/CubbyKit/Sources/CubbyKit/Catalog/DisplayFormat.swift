import CubbyAPISupport
import Foundation

/// The display formats a catalog field renders identically on web and native: fixed en-US shapes,
/// independent of the device locale, pinned by `packages/shared/golden-vectors/display-format.json`.
/// Currency, bare numbers, and nutrition cells come from the one Rust implementation the web also
/// calls (`ValueFormat`); only `plainDate` is Swift (the web twin is `formatCalendarDay`; Rust has
/// no timezone database). Change a rule by editing the vector first, then Rust (and `plainDate`).
public enum DisplayFormat {
    /// `currency` and `signedCurrency`: USD with grouping and cents (`-$5.00`). The sign is never
    /// spelled `+`; the web only colours it.
    public static func currency(_ value: Double) -> String {
        ValueFormat.currency(value)
    }

    /// `plainDate`: a real `YYYY-MM-DD` day as `MMM d, yyyy`; anything else comes back unchanged.
    public static func plainDate(_ value: String) -> String {
        guard let day = PlainDate(rawValue: value).date(in: .gmt) else { return value }
        return day.formatted(
            Date.VerbatimFormatStyle(
                format: "\(month: .abbreviated) \(day: .defaultDigits), \(year: .defaultDigits)",
                locale: Locale(identifier: "en_US_POSIX"), timeZone: .gmt,
                calendar: Calendar(identifier: .gregorian)))
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
        ValueFormat.compactEstimate(figure(estimate), unit: unit.format)
    }

    /// The long form for detail text and accessibility, the web's `formatEstimate`: the figure or
    /// range, `unit` once, then its confidence (`420 kcal known · partial`, `Pending`, `N/A`).
    public static func estimate(
        _ estimate: MeasureEstimate, measure: ValueFormat.EstimateMeasure, unit: String? = nil
    ) -> String {
        ValueFormat.estimate(figure(estimate), measure: measure, unit: unit)
    }

    private static func figure(_ estimate: MeasureEstimate) -> ValueFormat.Estimate {
        switch estimate {
        case .complete(let known):
            .complete(lower: known.lower, upper: known.upper, inferredZero: estimate.inferredZeroCount)
        case .partial(let known):
            .partial(lower: known.lower, upper: known.upper, inferredZero: estimate.inferredZeroCount)
        case .unavailable: .unavailable(notApplicable: estimate.isNotApplicable)
        case .pending: .pending
        }
    }
}
