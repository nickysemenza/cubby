import Foundation
import Testing

@testable import CubbyKit

/// Shared with `apps/web/src/lib/household-date.unit.test.ts`: both clients cut the household's
/// day at the same instants (`packages/shared/golden-vectors/household-day.json`).
@Suite("HouseholdDay")
struct HouseholdDayTests {
    private struct Day: Decodable {
        let instant: String
        let day: String
    }
    private struct File: Decodable {
        let timeZone: String
        let days: [Day]
    }

    @Test func usesTheSharedHouseholdZone() throws {
        let file = try GoldenVectors.decode(File.self, named: "household-day")
        #expect(HouseholdDay.timeZone.identifier == file.timeZone)
    }

    @Test func cutsTheDayAtTheSharedInstants() throws {
        let file = try GoldenVectors.decode(File.self, named: "household-day")
        let parser = ISO8601DateFormatter()
        for vector in file.days {
            let instant = try #require(parser.date(from: vector.instant))
            #expect(HouseholdDay.string(for: instant) == vector.day, "instant \(vector.instant)")
        }
    }
}
