import Foundation

/// Display-only dates: calendar values never pass through an instant's UTC day. Display text
/// follows `locale` (the person's language and 12/24-hour clock); only the household zone and
/// the Gregorian calendar are fixed.
public struct DatePresentation: Sendable, Equatable {
    public let absolute: String
    public let relative: String
    public let exact: String
    public var text: String { "\(absolute) · \(relative)" }

    /// Fractional seconds first, then whole seconds, through one shared transcoder: every
    /// rendered timestamp parses here, and allocating a formatter per call dominated it.
    public static func parse(_ value: String) -> Date? {
        try? transcoder.decode(value)
    }

    private static let transcoder = LenientISO8601DateTranscoder()

    public static func timestamp(
        _ date: Date, now: Date = .now, compact: Bool = false, locale: Locale = .autoupdatingCurrent
    ) -> Self {
        Self(
            absolute: absolute(date, now: now, compact: compact, locale: locale),
            relative: distance(date.timeIntervalSince(now), compact: compact),
            exact: date.formatted(
                style(locale).month(.abbreviated).day().year().hour().minute().second()
                    .timeZone(.specificName(.short))))
    }

    /// `timestamp(_:now:compact:).absolute` alone, for labels that never show the age or zone.
    public static func absolute(
        _ date: Date, now: Date = .now, compact: Bool = false, locale: Locale = .autoupdatingCurrent
    ) -> String {
        guard compact else {
            return date.formatted(style(locale).month(.abbreviated).day().year().hour().minute())
        }
        return day(date, now: now, compact: true, locale: locale)
    }

    /// Capture provenance preserves the camera's recorded offset, without a live age.
    public static func captureTimestamp(
        _ date: Date, offsetMinutes: Int?, locale: Locale = .autoupdatingCurrent
    ) -> String {
        guard let offsetMinutes else { return timestamp(date, locale: locale).exact }
        let seconds = offsetMinutes.multipliedReportingOverflow(by: 60)
        guard !seconds.overflow, let timeZone = TimeZone(secondsFromGMT: seconds.partialValue) else {
            return timestamp(date, locale: locale).exact
        }
        let local = date.formatted(
            style(locale, timeZone: timeZone).month(.abbreviated).day().year().hour().minute().second())
        let magnitude = abs(offsetMinutes)
        let hours = magnitude / 60 < 10 ? "0\(magnitude / 60)" : "\(magnitude / 60)"
        let minutes = magnitude % 60 < 10 ? "0\(magnitude % 60)" : "\(magnitude % 60)"
        return "\(local) (\(offsetMinutes < 0 ? "-" : "+")\(hours):\(minutes))"
    }

    public static func plainDate(
        _ value: String, now: Date = .now, compact: Bool = false, locale: Locale = .autoupdatingCurrent
    ) -> Self? {
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
        return Self(
            absolute: day(date, now: now, compact: compact, locale: locale), relative: relative,
            exact: value)
    }

    public static func value(
        _ value: String, now: Date = .now, compact: Bool = false, locale: Locale = .autoupdatingCurrent
    ) -> Self? {
        if let day = plainDate(value, now: now, compact: compact, locale: locale) { return day }
        return parse(value).map { timestamp($0, now: now, compact: compact, locale: locale) }
    }

    /// `value(_:now:compact:)?.absolute` without building the age and zone strings it discards.
    public static func absolute(
        of value: String, now: Date = .now, compact: Bool = false, locale: Locale = .autoupdatingCurrent
    ) -> String? {
        if let date = HouseholdDay.date(from: value) {
            return day(date, now: now, compact: compact, locale: locale)
        }
        return parse(value).map { absolute($0, now: now, compact: compact, locale: locale) }
    }

    /// Whether `value(_:)` reads `value` as a date, without formatting it.
    public static func isDate(_ value: String) -> Bool {
        HouseholdDay.date(from: value) != nil || parse(value) != nil
    }

    private static let calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = HouseholdDay.timeZone
        return value
    }()

    /// The chosen fields in the locale's own order and clock. A fixed POSIX pattern printed
    /// English month names and a 12-hour clock for everyone; keep POSIX for wire formats only.
    private static func style(_ locale: Locale, timeZone: TimeZone = HouseholdDay.timeZone)
        -> Date.FormatStyle
    {
        var calendar = calendar
        calendar.locale = locale
        return Date.FormatStyle(locale: locale, calendar: calendar, timeZone: timeZone)
    }

    /// A calendar day; a compact one drops the year when it is this year.
    private static func day(_ date: Date, now: Date, compact: Bool, locale: Locale) -> String {
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        let style = style(locale).month(.abbreviated).day()
        return date.formatted(compact && sameYear ? style : style.year())
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
