import CubbyKit
import Foundation
import Observation

/// The loading lifecycle for one Today section. Sections load independently — one section's
/// failure never blanks the others, so each gets its own state rather than the screen sharing a
/// single `Result`.
enum TodaySectionState<Value> {
    case loading
    case loaded(Value)
    case failed(String)
}

// `TodayTask`, `TodayMeal`, and `TodayProblemCounts` live in CubbyKit (`Today/TodayModels.swift`)
// now — the widget and App Intents read the same briefing shapes.

/// Screen state for Today: the briefing, problem counts, and today's meals, each loaded
/// independently so one failing endpoint doesn't blank the rest of the screen. Created per client
/// (see `CaptureModel`), so a base URL change gets a fresh one.
@Observable
final class TodayModel {
    private(set) var tasks: TodaySectionState<[TodayTask]> = .loading
    private(set) var meals: TodaySectionState<[TodayMeal]> = .loading
    private(set) var problems: TodaySectionState<TodayProblemCounts> = .loading

    private let client: CubbyClient

    init(client: CubbyClient) {
        self.client = client
    }

    /// Loads all three sections concurrently. Each is independently failable: a thrown error in
    /// one becomes that section's `.failed` state without touching the others.
    func refresh() async {
        async let tasksResult = fetchTasks()
        async let mealsResult = fetchMeals()
        async let problemsResult = fetchProblems()
        tasks = await tasksResult
        meals = await mealsResult
        problems = await problemsResult
    }

    private func fetchTasks() async -> TodaySectionState<[TodayTask]> {
        do {
            return .loaded(try await client.todayBriefing())
        } catch {
            Diagnostics.report(error, context: "today.tasks")
            return .failed(message(for: error))
        }
    }

    private func fetchMeals() async -> TodaySectionState<[TodayMeal]> {
        do {
            return .loaded(try await client.meals(on: .now))
        } catch {
            Diagnostics.report(error, context: "today.meals")
            return .failed(message(for: error))
        }
    }

    private func fetchProblems() async -> TodaySectionState<TodayProblemCounts> {
        do {
            return .loaded(try await client.problemCounts())
        } catch {
            Diagnostics.report(error, context: "today.problems")
            return .failed(message(for: error))
        }
    }

    private func message(for error: any Error) -> String {
        (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
    }
}
