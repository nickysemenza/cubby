import CubbyAPISupport
import Foundation

/// Calendar-day helpers for the household's configured time zone. Meal planning and logging use
/// this boundary even while the device is travelling elsewhere.
public enum HouseholdDay {
    /// Generated from `HOUSEHOLD_TIMEZONE` (`packages/shared/src/client-constants.ts`).
    public static let timeZone = TimeZone(identifier: SharedConstants.householdTimeZoneIdentifier)!

    public static func string(for date: Date) -> String {
        PlainDate(date, in: timeZone).rawValue
    }

    public static func date(from value: String) -> Date? {
        PlainDate(rawValue: value).date(in: timeZone)
    }

    public static func isFuture(_ value: String, relativeTo now: Date = .now) -> Bool {
        guard let candidate = Self.date(from: value),
            let today = Self.date(from: Self.string(for: now))
        else { return false }
        return candidate > today
    }
}
