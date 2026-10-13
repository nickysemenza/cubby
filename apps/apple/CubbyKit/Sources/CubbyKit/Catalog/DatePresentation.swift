import Foundation

/// Display-only dates: calendar values never pass through an instant's UTC day.
public struct DatePresentation: Sendable, Equatable {
    public let absolute: String
    public let relative: String
    public let exact: String
    public var text: String { "\(absolute) · \(relative)" }

    public static func parse(_ value: String) -> Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = parser.date(from: value) { return date }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: value)
    }

    public static func timestamp(_ date: Date, now: Date = .now, compact: Bool = false) -> Self {
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        let pattern = compact ? (sameYear ? "MMM d" : "MMM d, yyyy") : "MMM d, yyyy, h:mm a"
        let absolute = format(date, pattern: pattern)
        return Self(
            absolute: absolute, relative: distance(date.timeIntervalSince(now), compact: compact),
            exact: format(date, pattern: "MMM d, yyyy, h:mm:ss a zzz"))
    }

    /// Capture provenance preserves the camera's recorded offset, without a live age.
    public static func captureTimestamp(_ date: Date, offsetMinutes: Int?) -> String {
        guard let offsetMinutes else { return timestamp(date).exact }
        let seconds = offsetMinutes.multipliedReportingOverflow(by: 60)
        guard !seconds.overflow, let timeZone = TimeZone(secondsFromGMT: seconds.partialValue) else {
            return timestamp(date).exact
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.dateFormat = "MMM d, yyyy, h:mm:ss a (xxx)"
        return formatter.string(from: date)
    }

    public static func plainDate(_ value: String, now: Date = .now, compact: Bool = false) -> Self? {
        guard let date = HouseholdDay.date(from: value) else { return nil }
        let today = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: today, to: date).day ?? 0
        let relative: String
        switch days {
        case 0: relative = "today"
        case -1: relative = "yesterday"
        case 1: relative = "tomorrow"
        default:
            if compact {
                let magnitude = abs(days)
                let amount: String
                if magnitude < 7 {
                    amount = "\(magnitude)d"
                } else if magnitude < 30 {
                    amount = "\(Int((Double(magnitude) / 7).rounded()))w"
                } else if magnitude < 365 {
                    amount = "\(min(11, max(1, Int((Double(magnitude) / 30.4375).rounded())))) mo"
                } else {
                    amount = "\(Int((Double(magnitude) / 365.2425).rounded()))y"
                }
                relative = days > 0 ? "in \(amount)" : "\(amount) ago"
            } else {
                let magnitude = abs(days)
                let amount: String
                if magnitude < 30 {
                    amount = "\(magnitude) days"
                } else if magnitude < 365 {
                    let months = min(11, max(1, Int((Double(magnitude) / 30.4375).rounded())))
                    amount = "about \(months) month" + (months == 1 ? "" : "s")
                } else {
                    let years = max(1, Int((Double(magnitude) / 365.2425).rounded()))
                    amount = "about \(years) year" + (years == 1 ? "" : "s")
                }
                relative = days > 0 ? "in \(amount)" : "\(amount) ago"
            }
        }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return Self(
            absolute: format(date, pattern: compact && sameYear ? "MMM d" : "MMM d, yyyy"),
            relative: relative, exact: value)
    }

    public static func value(_ value: String, now: Date = .now, compact: Bool = false) -> Self? {
        if let day = plainDate(value, now: now, compact: compact) { return day }
        return parse(value).map { timestamp($0, now: now, compact: compact) }
    }

    private static let calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = HouseholdDay.timeZone
        return value
    }()

    private static let formatters: [String: DateFormatter] = {
        let patterns = ["MMM d", "MMM d, yyyy", "MMM d, yyyy, h:mm a", "MMM d, yyyy, h:mm:ss a zzz"]
        return Dictionary(
            uniqueKeysWithValues: patterns.map { pattern in
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: "en_US_POSIX")
                formatter.calendar = calendar
                formatter.timeZone = HouseholdDay.timeZone
                formatter.dateFormat = pattern
                return (pattern, formatter)
            })
    }()

    private static func format(_ date: Date, pattern: String) -> String {
        formatters[pattern]!.string(from: date)
    }

    private static func distance(_ seconds: Double, compact: Bool) -> String {
        let magnitude = abs(seconds).rounded()
        if magnitude < 45 { return "now" }
        let minutes = Int((magnitude / 60).rounded())
        let hours = Int((Double(minutes) / 60).rounded())
        let days = Int((Double(hours) / 24).rounded())
        let count: Int
        let unit: String
        let approximate: Bool
        if minutes < 60 {
            count = minutes; unit = compact ? "min" : "minute"; approximate = false
        } else if hours < 24 {
            count = hours; unit = compact ? "h" : "hour"; approximate = true
        } else if days < 7 || (!compact && days < 30) {
            count = days; unit = compact ? "d" : "day"; approximate = false
        } else if days < 30 {
            count = Int((Double(days) / 7).rounded()); unit = "w"; approximate = false
        } else if days < 365 {
            count = min(11, max(1, Int((Double(days) / 30.4375).rounded()))); unit = compact ? "mo" : "month";
            approximate = true
        } else {
            count = Int((Double(days) / 365.2425).rounded()); unit = compact ? "y" : "year";
            approximate = true
        }
        let label = unit + (!compact && count != 1 ? "s" : "")
        let space = !compact || unit == "min" || unit == "mo" ? " " : ""
        let amount = (!compact && approximate ? "about " : "") + "\(count)\(space)\(label)"
        return seconds > 0 ? "in \(amount)" : "\(amount) ago"
    }
}
