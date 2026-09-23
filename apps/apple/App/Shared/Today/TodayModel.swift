import CubbyKit
import Foundation
import Observation

enum TodaySectionState<Value> {
    case loading
    case loaded(Value)
    case failed(String)
}

/// Screen state for Today. Each section owns its request, activity, and error so completed data
/// appears immediately and a refresh failure never blanks the last useful value.
@MainActor
@Observable
final class TodayModel {
    private(set) var tasks: TodaySectionState<TaskTodayBriefingOut> = .loading
    private(set) var meals: TodaySectionState<[MealListItem]> = .loading
    private(set) var problems: TodaySectionState<ProblemsCount> = .loading

    private(set) var tasksIsLoading = false
    private(set) var mealsIsLoading = false
    private(set) var problemsIsLoading = false
    private(set) var tasksError: String?
    private(set) var mealsError: String?
    private(set) var problemsError: String?

    private let client: CubbyClient
    private var tasksGeneration = 0
    private var mealsGeneration = 0
    private var problemsGeneration = 0
    private var tasksRequest: Task<Void, Never>?
    private var mealsRequest: Task<Void, Never>?
    private var problemsRequest: Task<Void, Never>?

    init(client: CubbyClient) {
        self.client = client
    }

    /// Starts all sections together, while each publishes at its own completion point.
    func refresh() async {
        async let tasks: Void = refreshTasks()
        async let meals: Void = refreshMeals()
        async let problems: Void = refreshProblems()
        _ = await (tasks, meals, problems)
    }

    func refreshTasks() async {
        tasksRequest?.cancel()
        tasksGeneration += 1
        let generation = tasksGeneration
        tasksIsLoading = true
        tasksError = nil
        let retained = loadedTasks
        let client = client
        let request = Task { [weak self] in
            do {
                let value = try await client.todayBriefing()
                try Task.checkCancellation()
                guard let self, generation == self.tasksGeneration else { return }
                self.tasks = .loaded(value)
            } catch is CancellationError {
                // A newer refresh owns this section.
            } catch {
                guard let self, generation == self.tasksGeneration else { return }
                let message = self.message(for: error)
                if let retained {
                    self.tasksError = message
                    self.tasks = .loaded(retained)
                } else {
                    self.tasks = .failed(message)
                }
                Diagnostics.report(error, context: "today.tasks")
            }
        }
        tasksRequest = request
        await request.value
        guard generation == tasksGeneration else { return }
        tasksRequest = nil
        tasksIsLoading = false
    }

    func refreshMeals() async {
        mealsRequest?.cancel()
        mealsGeneration += 1
        let generation = mealsGeneration
        mealsIsLoading = true
        mealsError = nil
        let retained = loadedMeals
        let client = client
        let request = Task { [weak self] in
            do {
                let value = try await client.meals(on: .now)
                try Task.checkCancellation()
                guard let self, generation == self.mealsGeneration else { return }
                self.meals = .loaded(value)
            } catch is CancellationError {
                // A newer refresh owns this section.
            } catch {
                guard let self, generation == self.mealsGeneration else { return }
                let message = self.message(for: error)
                if let retained {
                    self.mealsError = message
                    self.meals = .loaded(retained)
                } else {
                    self.meals = .failed(message)
                }
                Diagnostics.report(error, context: "today.meals")
            }
        }
        mealsRequest = request
        await request.value
        guard generation == mealsGeneration else { return }
        mealsRequest = nil
        mealsIsLoading = false
    }

    func refreshProblems() async {
        problemsRequest?.cancel()
        problemsGeneration += 1
        let generation = problemsGeneration
        problemsIsLoading = true
        problemsError = nil
        let retained = loadedProblems
        let client = client
        let request = Task { [weak self] in
            do {
                let value = try await client.problemCounts()
                try Task.checkCancellation()
                guard let self, generation == self.problemsGeneration else { return }
                self.problems = .loaded(value)
            } catch is CancellationError {
                // A newer refresh owns this section.
            } catch {
                guard let self, generation == self.problemsGeneration else { return }
                let message = self.message(for: error)
                if let retained {
                    self.problemsError = message
                    self.problems = .loaded(retained)
                } else {
                    self.problems = .failed(message)
                }
                Diagnostics.report(error, context: "today.problems")
            }
        }
        problemsRequest = request
        await request.value
        guard generation == problemsGeneration else { return }
        problemsRequest = nil
        problemsIsLoading = false
    }

    private var loadedTasks: TaskTodayBriefingOut? {
        if case .loaded(let value) = tasks { return value }
        return nil
    }

    private var loadedMeals: [MealListItem]? {
        if case .loaded(let value) = meals { return value }
        return nil
    }

    private var loadedProblems: ProblemsCount? {
        if case .loaded(let value) = problems { return value }
        return nil
    }

    private func message(for error: any Error) -> String {
        (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
    }
}
