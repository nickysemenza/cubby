import Foundation

/// Formats declared full-filtered-set totals for Browse and the CLI. A missing server key is
/// unavailable, while an actual zero is a value. Values never come from loaded list rows.
public enum ListTotalsSummary {
    public static func line(
        totals: [ListTotalDescriptor], sums: [String: Double]?, locale: Locale = .current
    ) -> String? {
        guard !totals.isEmpty else { return nil }
        let values = totals.map { total in
            "\(total.label): \(formattedValue(total, sums: sums, locale: locale) ?? "Unavailable")"
        }
        return "All matching · \(values.joined(separator: " · "))"
    }

    private static func formattedValue(
        _ total: ListTotalDescriptor, sums: [String: Double]?, locale: Locale
    ) -> String? {
        let values = total.keys.compactMap { sums?[$0] }
        guard values.count == total.keys.count, values.allSatisfy(\.isFinite) else { return nil }
        switch total.format {
        case .currency:
            guard values.count == 1 else { return nil }
            return currency(values[0], locale: locale)
        case .currencyRange:
            guard values.count == 2 else { return nil }
            return "\(currency(values[0], locale: locale))–\(currency(values[1], locale: locale))"
        case .integer:
            guard values.count == 1 else { return nil }
            return values[0].formatted(.number.precision(.fractionLength(0)).locale(locale))
        }
    }

    private static func currency(_ value: Double, locale: Locale) -> String {
        value.formatted(.usd.locale(locale))
    }
}
