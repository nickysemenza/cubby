import Foundation

/// A date range bound relative to the household's today (#2415): `@today`, `@today-30d`,
/// `@today+7d`. Filter state and saved views keep the token; the server resolves it to the
/// household-local day at query time, so a saved view stays current. Mirrors
/// `relativeDateOffset` in `packages/shared/src/filter.ts`.
public enum RelativeDate {
    public static let today = "@today"

    /// The token's whole-day offset from today (negative is the past), or nil for any other
    /// value, such as a "YYYY-MM-DD" day.
    public static func offset(_ value: String) -> Int? {
        guard value.hasPrefix(today) else { return nil }
        let rest = value.dropFirst(today.count)
        if rest.isEmpty { return 0 }
        guard let sign = rest.first, sign == "-" || sign == "+", rest.hasSuffix("d") else { return nil }
        let digits = rest.dropFirst().dropLast()
        guard (1...5).contains(digits.count), digits.allSatisfy(\.isASCIIDigit), let days = Int(digits)
        else { return nil }
        return sign == "-" ? -days : days
    }

    /// The token `days` whole days from today.
    public static func token(_ days: Int) -> String {
        days == 0 ? today : "\(today)\(days < 0 ? "-" : "+")\(abs(days))d"
    }

    /// "today", "today − 30 days", "today + 1 day".
    public static func describe(_ days: Int) -> String {
        if days == 0 { return "today" }
        let count = abs(days)
        return "today \(days < 0 ? "−" : "+") \(count) \(count == 1 ? "day" : "days")"
    }
}

extension Character {
    fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}
