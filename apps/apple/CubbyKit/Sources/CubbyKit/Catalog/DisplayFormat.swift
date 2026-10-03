import Foundation

/// The display formats a catalog field renders identically on web and native: fixed en-US shapes,
/// independent of the device locale, pinned by `packages/shared/golden-vectors/display-format.json`
/// (the web twins are `formatCurrency`, `formatCalendarDay`, and `compactEstimateText`). Change a
/// rule by editing the vector first, then both implementations.
public enum DisplayFormat {
    private static let locale = Locale(identifier: "en_US")
    private static let monthNames = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]

    /// `currency` and `signedCurrency`: USD with grouping and cents (`-$5.00`). The sign is never
    /// spelled `+`; the web only colours it.
    public static func currency(_ value: Double) -> String {
        // ICU (the web) rounds the shortest decimal form half away from zero; formatting the
        // Double directly rounds half to even on its binary value (0.125 -> $0.12).
        let decimal = Decimal(string: "\(value)") ?? Decimal(value)
        var source = decimal
        var rounded = Decimal()
        NSDecimalRound(&rounded, &source, 2, .plain)
        return rounded.formatted(.usd)
    }

    /// `plainDate`: a real `YYYY-MM-DD` day as `MMM d, yyyy`; anything else comes back unchanged.
    public static func plainDate(_ value: String) -> String {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
            let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
            (1...12).contains(month), day >= 1
        else { return value }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let first = calendar.date(from: DateComponents(year: year, month: month, day: 1)),
            let days = calendar.range(of: .day, in: .month, for: first), days.contains(day)
        else { return value }
        return "\(monthNames[month - 1]) \(day), \(year)"
    }

    /// A bare numeric field: the shortest round-trip decimal, no grouping and no rounding — what
    /// the web prints for a raw JS number.
    public static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : "\(value)"
    }

    public enum EstimateUnit: Sendable {
        case kcal
        case macro
    }

    /// The one-line macro/cost cell: kcal rounds half-up to a whole number, a macro to one
    /// decimal, both grouped; a range joins with an en dash, a partial estimate ends in `+`, and
    /// anything unavailable or pending is `—`.
    public static func compactEstimate(_ estimate: MeasureEstimate, unit: EstimateUnit) -> String {
        guard let known = knownRange(estimate, unit: unit) else { return "—" }
        if case .partial = estimate { return known + "+" }
        return known
    }

    /// The figure of a complete or partial estimate, without the partial marker; `nil` when
    /// nothing is known.
    public static func knownRange(_ estimate: MeasureEstimate, unit: EstimateUnit) -> String? {
        switch estimate {
        case .complete(let known): range(lower: known.lower, upper: known.upper, unit: unit)
        case .partial(let known): range(lower: known.lower, upper: known.upper, unit: unit)
        case .unavailable, .pending: nil
        }
    }

    private static func range(lower: Double, upper: Double?, unit: EstimateUnit) -> String {
        let lowerText = compactNumber(lower, unit: unit)
        guard let upper, upper != lower else { return lowerText }
        return "\(lowerText)–\(compactNumber(upper, unit: unit))"
    }

    /// Mirrors the web's `Math.round` / `roundTo(value, 1)`: halves round up, not to even.
    private static func compactNumber(_ value: Double, unit: EstimateUnit) -> String {
        switch unit {
        case .kcal:
            return (value + 0.5).rounded(.down).formatted(
                .number.precision(.fractionLength(0)).locale(locale))
        case .macro:
            let rounded = ((value + .ulpOfOne) * 10 + 0.5).rounded(.down) / 10
            return rounded.formatted(.number.precision(.fractionLength(0...1)).locale(locale))
        }
    }
}
