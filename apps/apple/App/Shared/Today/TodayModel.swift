import CubbyKit
import Foundation
import Observation

enum TodaySectionState<Value> {
    case loading
    case loaded(Value)
    case failed(String)
}

/// Reading order is shared by the compact and readable-width Today lists.
enum TodaySection: String, CaseIterable, Identifiable {
    case tasks = "Next up"
    case activity = "Activity inbox"
    case meals = "Meals today"
    case nutrition = "Nutrition today"
    case changes = "Recent changes"
    case views = "Your views"

    var id: Self { self }
}

/// Screen state for Today. Each section owns its request, activity, and error so completed data
/// appears immediately and a refresh failure never blanks the last useful value.
@MainActor
@Observable
final class TodayModel {
    private(set) var tasks: TodaySectionState<EntityReportOut> = .loading
    private(set) var meals: TodaySectionState<[EntityRow]> = .loading

    private(set) var tasksIsLoading = false
    private(set) var mealsIsLoading = false
    private(set) var tasksError: String?
    private(set) var mealsError: String?

    /// Runs the briefing rows' commands (a task's Done) on the shared report-command path; a
    /// finished command reloads the briefing.
    let taskCommands: ReportSlotModel

    private let client: CubbyClient
    private var tasksGeneration = 0
    private var mealsGeneration = 0
    private var tasksRequest: Task<Void, Never>?
    private var mealsRequest: Task<Void, Never>?

    init(client: CubbyClient) {
        self.client = client
        taskCommands = ReportSlotModel(slot: .taskBriefing, id: "", service: client)
        taskCommands.reload = { [weak self] in await self?.refreshTasks() }
    }

    /// Starts all sections together, while each publishes at its own completion point.
    func refresh() async {
        async let tasks: Void = refreshTasks()
        async let meals: Void = refreshMeals()
        _ = await (tasks, meals)
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
                let message = error.userMessage
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
                let message = error.userMessage
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

    private var loadedTasks: EntityReportOut? {
        if case .loaded(let value) = tasks { return value }
        return nil
    }

    private var loadedMeals: [EntityRow]? {
        if case .loaded(let value) = meals { return value }
        return nil
    }

    /// A total outage has one recovery path. Deduplicate identical transport diagnostics while
    /// retaining every distinct raw response; a loaded or pending section keeps the dashboard.
    static func failureMessage(
        tasks: TodaySectionState<EntityReportOut>, meals: TodaySectionState<[EntityRow]>,
        nutrition: TodaySectionState<MealNutritionOut>, changesError: String?
    ) -> String? {
        guard case .failed(let tasksError) = tasks, case .failed(let mealsError) = meals,
            case .failed(let nutritionError) = nutrition, let changesError
        else { return nil }
        return [tasksError, mealsError, nutritionError, changesError]
            .reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            .joined(separator: "\n\n")
    }
}

/// Today's layout of the server-owned briefing. Keep row commands and evidence on the generic
/// report renderer; only reorder presentation, bound the stats, and make its footer navigable.
struct TodayBriefingPresentation {
    let tasks: EntityReportOut
    let stats: EntityReportOut
    let moreReady: [String]

    init(_ report: EntityReportOut) {
        var tasks = report
        var stats = report
        var footers: [String] = []
        tasks.blocks = report.blocks.compactMap { block in
            switch block {
            case .stats: return nil
            case .records(var records):
                if let footer = records.footer { footers.append(footer) }
                records.footer = nil
                records.title = nil
                records.rows = records.rows.map { row in
                    var row = row
                    if let due = row.trailing, let date = DatePresentation.plainDate(due) {
                        row.trailing = date.text
                    }
                    return row
                }
                return .records(records)
            default: return block
            }
        }
        stats.blocks = report.blocks.compactMap { block in
            guard case .stats(var stats) = block else { return nil }
            stats.figures = stats.figures.filter { ["Overdue", "Due this week"].contains($0.label) }
            return stats.figures.isEmpty ? nil : .stats(stats)
        }
        self.tasks = tasks
        self.stats = stats
        moreReady = footers
    }
}
