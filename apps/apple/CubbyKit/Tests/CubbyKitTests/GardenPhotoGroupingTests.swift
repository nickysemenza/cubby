import CubbyKit
import Foundation
import Testing

struct GardenPhotoGroupingTests {
    @Test func groupsByGregorianDayAndKeepsSourceOrder() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let first = Date(timeIntervalSince1970: 1_735_732_800)  // 2025-01-01 00:00 UTC
        let second = first.addingTimeInterval(60 * 60)
        let next = first.addingTimeInterval(86_400)

        let groups = GardenPhotoGrouping.groups(
            capturedAt: [second, nil, next, first], calendar: calendar)

        #expect(groups.map(\.indexes) == [[0, 3], [2], [1]])
        #expect(groups[0].day == calendar.startOfDay(for: first))
        #expect(groups[2].day == nil)
    }
}
