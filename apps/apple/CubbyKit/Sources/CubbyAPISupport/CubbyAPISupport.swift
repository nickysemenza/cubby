import Foundation

/// Hand-written types the generated `CubbyAPI` client uses in place of its own: the branded
/// shortcodes and the `YYYY-MM-DD` plain date (`typeOverrides.schemas` in
/// `Sources/CubbyAPI/openapi-generator-config.yaml`, written by `scripts/generator/http-api/native.ts`).
/// Each is a single JSON string on the wire, so `RawRepresentable` supplies `Codable`.

/// A calendar day with no time or zone, as the API spells `PlainDate`. The zone defaults to the
/// device's current one, which is what a garden log or a meal plan means by "that day";
/// `HouseholdDay` passes the household zone instead.
public struct PlainDate: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public init(_ date: Date, in timeZone: TimeZone = .current) {
        rawValue = date.formatted(Self.style(timeZone))
    }

    /// The instant the day starts in `timeZone`; nil when `rawValue` is not a valid `YYYY-MM-DD`.
    public func date(in timeZone: TimeZone = .current) -> Date? {
        // The ISO parser rolls `2026-02-30` over to March and ignores a trailing time, so only a
        // value that formats back to itself is a day (`golden-vectors/display-format.json`).
        let style = Self.style(timeZone)
        guard let date = try? Date(rawValue, strategy: style), date.formatted(style) == rawValue
        else { return nil }
        return date
    }

    private static func style(_ timeZone: TimeZone) -> Date.ISO8601FormatStyle {
        Date.ISO8601FormatStyle(timeZone: timeZone).year().month().day()
    }
}

public struct ProductCode: RawRepresentable, Sendable, Hashable, Codable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}

public struct LocationCode: RawRepresentable, Sendable, Hashable, Codable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}

public struct InventoryEntryCode: RawRepresentable, Sendable, Hashable, Codable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}

public struct ImageCode: RawRepresentable, Sendable, Hashable, Codable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
}
