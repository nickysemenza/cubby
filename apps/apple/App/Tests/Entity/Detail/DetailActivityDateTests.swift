import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Detail activity dates")
struct DetailActivityDateTests {
    @Test func calendarDateDoesNotShiftIntoThePreviousZoneDay() throws {
        let date = try #require(ISO8601DateFormatter().date(from: "2026-09-08T00:00:00Z"))

        #expect(DetailActivityDate.day(for: date, allDay: true) == "2026-09-08")
        #expect(DetailActivityDate.day(for: date, allDay: false) == HouseholdDay.string(for: date))
    }
}
