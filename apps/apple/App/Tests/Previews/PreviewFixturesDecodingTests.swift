import CubbyKit
import Foundation
import Testing

@testable import Cubby

/// Backstop for the generated `Fixtures/*.json`: `PreviewFixtures.fixture(_:)` `fatalError`s on a
/// fixture that no longer decodes, which crashes a `#Preview` instead of failing a test. The
/// fixtures are generated from the same zod schemas as the API document, so this catches a
/// wire-shape decode regression.
@Suite struct PreviewFixturesDecodingTests {
    nonisolated enum Fixture: CaseIterable, Sendable {
        case timeline, todayTasks, todayMeals, todayProblems, mealNutrition
    }

    @Test(arguments: Fixture.allCases)
    func generatedFixtureDecodes(_ fixture: Fixture) throws {
        switch fixture {
        case .timeline: try decode(EntityTimelineOut.self, "sampleTimeline")
        case .todayTasks: try decode(EntityReportOut.self, "sampleTodayBriefing")
        case .todayMeals:
            try decode([JSONValue].self, "sampleTodayMeals")
            #expect(PreviewFixtures.sampleTodayMeals.allSatisfy { !$0.id.isEmpty && !$0.title.isEmpty })
        case .todayProblems: try decode(ProblemsCount.self, "sampleTodayProblems")
        case .mealNutrition: try decode(MealNutritionOut.self, "sampleMealNutrition")
        }
    }

    private func decode<T: Decodable>(_: T.Type, _ name: String) throws {
        let url = try #require(Bundle.main.url(forResource: name, withExtension: "json"))
        _ = try JSONDecoder.cubby().decode(T.self, from: Data(contentsOf: url))
    }
}
