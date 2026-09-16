import Foundation

/// Calendar-day helpers for the household's configured time zone. Meal planning and logging use
/// this boundary even while the device is travelling elsewhere.
public enum HouseholdDay {
    public static let timeZone = TimeZone(identifier: "America/Los_Angeles")!

    public static func string(for date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    public static func date(from value: String) -> Date? {
        formatter.date(from: value)
    }

    public static func isFuture(_ value: String, relativeTo now: Date = .now) -> Bool {
        guard let candidate = Self.date(from: value),
            let today = Self.date(from: Self.string(for: now))
        else { return false }
        return candidate > today
    }

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static var formatter: DateFormatter {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }
}
