import Foundation

/// Stable calendar-day buckets for garden photo imports. The UI owns the photo values; CubbyKit
/// only owns the date semantics so grouping stays testable and independent of PhotoKit.
public struct GardenPhotoGroup: Sendable, Hashable {
    public let day: Date?
    public let indexes: [Int]

    public init(day: Date?, indexes: [Int]) {
        self.day = day
        self.indexes = indexes
    }
}

public enum GardenPhotoGrouping {
    /// Groups input positions by the user's current Gregorian calendar day, preserving source
    /// order within each group and placing undated selections last.
    public static func groups(
        capturedAt dates: [Date?], calendar: Calendar = .current
    ) -> [GardenPhotoGroup] {
        var dated: [Date: [Int]] = [:]
        var order: [Date] = []
        var undated: [Int] = []
        for (index, date) in dates.enumerated() {
            guard let date else { undated.append(index); continue }
            let day = calendar.startOfDay(for: date)
            if dated[day] == nil { order.append(day) }
            dated[day, default: []].append(index)
        }
        var result = order.sorted().map { GardenPhotoGroup(day: $0, indexes: dated[$0]!) }
        if !undated.isEmpty { result.append(GardenPhotoGroup(day: nil, indexes: undated)) }
        return result
    }
}
