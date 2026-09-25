import Foundation

/// Hand-written types the generated `CubbyAPI` client uses in place of its own: the branded
/// shortcodes and the `YYYY-MM-DD` plain date (`typeOverrides.schemas` in
/// `Sources/CubbyAPI/openapi-generator-config.yaml`, written by `scripts/generator/http-api/native.ts`).
/// Each is a single JSON string on the wire, so `RawRepresentable` supplies `Codable`.

/// A calendar day with no time or zone, as the API spells `PlainDate`. `date` interprets it in
/// the device's current zone, which is what a garden log or a meal plan means by "that day".
public struct PlainDate: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public init(_ date: Date) {
        let parts = Self.calendar.dateComponents([.year, .month, .day], from: date)
        rawValue = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    public var date: Date? {
        let parts = rawValue.split(separator: "-", omittingEmptySubsequences: false).compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Self.calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
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
