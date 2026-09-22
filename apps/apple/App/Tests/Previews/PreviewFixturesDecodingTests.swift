import CubbyKit
import Foundation
import Testing

@testable import Cubby

/// Backstop for `PreviewFixtures+Generated.swift`: `PreviewFixtures.decode(_:)` `fatalError`s on a
/// fixture that no longer decodes, which crashes a `#Preview` instead of failing a test. The
/// generator's `--check` in `pnpm apple check` catches schema drift first; this catches a decode
/// regression even when that step was skipped.
@Suite struct PreviewFixturesDecodingTests {
    nonisolated enum Fixture: CaseIterable, Sendable {
        case timeline, todayTasks, todayMeals, todayProblems, mealNutrition
    }

    @Test(arguments: Fixture.allCases)
    func generatedFixtureDecodes(_ fixture: Fixture) throws {
        switch fixture {
        case .timeline: try decode(EntityTimelineOut.self, PreviewFixtures.sampleTimelineJSON)
        case .todayTasks: try decode([TaskTodayBriefingItemOut].self, PreviewFixtures.sampleTodayTasksJSON)
        case .todayMeals: try decode([MealListItem].self, PreviewFixtures.sampleTodayMealsJSON)
        case .todayProblems: try decode(ProblemsCount.self, PreviewFixtures.sampleTodayProblemsJSON)
        case .mealNutrition: try decode(MealNutritionOut.self, PreviewFixtures.sampleMealNutritionJSON)
        }
    }

    private func decode<T: Decodable>(_: T.Type, _ json: String) throws {
        _ = try JSONDecoder.cubby().decode(T.self, from: Data(json.utf8))
    }
}
