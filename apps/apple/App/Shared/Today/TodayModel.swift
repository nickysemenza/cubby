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

/// One row from `task.todayBriefing`'s `next` array: an actionable task, already filtered and
/// capped (max 4) by the server.
struct TodayTask: Identifiable, Sendable {
    let id: String
    let name: String
    let status: String
    let dueDate: String?
    let dueEndDate: String?
    let projectId: String?
    let projectName: String?

    init?(_ value: JSONValue) {
        guard let id = value["id"]?.stringValue, let name = value["name"]?.stringValue else { return nil }
        self.id = id
        self.name = name
        self.status = value["status"]?.stringValue ?? "not_started"
        self.dueDate = value["dueDate"]?.stringValue
        self.dueEndDate = value["dueEndDate"]?.stringValue
        self.projectId = value["projectId"]?.stringValue
        self.projectName = value["projectName"]?.stringValue
    }

    /// Memberwise, for previews — the JSON-decoding initializer above is for live rows only.
    init(
        id: String, name: String, status: String, dueDate: String? = nil, dueEndDate: String? = nil,
        projectId: String? = nil, projectName: String? = nil
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.dueDate = dueDate
        self.dueEndDate = dueEndDate
        self.projectId = projectId
        self.projectName = projectName
    }
}

/// One row from `GET /api/v1/meals?from=&to=`, scoped to today: the meal itself plus the names of
/// any recipes attached to it.
struct TodayMeal: Identifiable, Sendable {
    let id: String
    let name: String
    let mealType: String?
    let mealKind: String
    let recipeNames: [String]

    init?(_ value: JSONValue) {
        guard let id = value["id"]?.stringValue, let name = value["name"]?.stringValue else { return nil }
        self.id = id
        self.name = name
        self.mealType = value["mealType"]?.stringValue
        self.mealKind = value["mealKind"]?.stringValue ?? "other"
        self.recipeNames = value["recipes"]?.arrayValue?.compactMap { $0["recipe"]?["name"]?.stringValue } ?? []
    }

    init(
        id: String, name: String, mealType: String? = nil, mealKind: String = "cooked",
        recipeNames: [String] = []
    ) {
        self.id = id
        self.name = name
        self.mealType = mealType
        self.mealKind = mealKind
        self.recipeNames = recipeNames
    }
}

/// `GET /api/v1/problems/getCounts`, trimmed to the two figures Today shows.
struct TodayProblemCounts: Sendable {
    let total: Int
    let coverageTotal: Int

    init?(_ value: JSONValue) {
        guard let total = value["total"]?.doubleValue, let coverageTotal = value["coverageTotal"]?.doubleValue
        else { return nil }
        self.total = Int(total)
        self.coverageTotal = Int(coverageTotal)
    }

    init(total: Int, coverageTotal: Int) {
        self.total = total
        self.coverageTotal = coverageTotal
    }
}

/// Screen state for Today: the briefing, problem counts, and today's meals, each loaded
/// independently so one failing endpoint doesn't blank the rest of the screen. Created per client
/// (see `CaptureModel`), so a base URL change gets a fresh one.
@Observable
final class TodayModel {
    private(set) var tasks: TodaySectionState<[TodayTask]> = .loading
    private(set) var meals: TodaySectionState<[TodayMeal]> = .loading
    private(set) var problems: TodaySectionState<TodayProblemCounts> = .loading

    private let client: CubbyClient

    /// `yyyy-MM-dd` in the device's own calendar and time zone — "today" means the day the user is
    /// currently in, not a UTC day that might already have rolled over.
    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

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
            let data = try await client.raw.call(
                OperationRoute(operationID: "task.todayBriefing", method: .get, path: "/api/v1/task/todayBriefing")
            )
            let tasks = data["next"]?.arrayValue?.compactMap(TodayTask.init) ?? []
            return .loaded(tasks)
        } catch {
            return .failed(message(for: error))
        }
    }

    private func fetchMeals() async -> TodaySectionState<[TodayMeal]> {
        do {
            let today = Self.dayFormatter.string(from: .now)
            let page = try await client.raw.list(
                basePath: "meals", page: 1, pageSize: 10, sort: "date",
                filters: ["from": .string(today), "to": .string(today)]
            )
            return .loaded(page.items.compactMap(TodayMeal.init))
        } catch {
            return .failed(message(for: error))
        }
    }

    private func fetchProblems() async -> TodaySectionState<TodayProblemCounts> {
        do {
            let data = try await client.raw.call(
                OperationRoute(operationID: "problems.getCounts", method: .get, path: "/api/v1/problems/getCounts")
            )
            guard let counts = TodayProblemCounts(data) else {
                return .failed("Unexpected response shape")
            }
            return .loaded(counts)
        } catch {
            return .failed(message(for: error))
        }
    }

    private func message(for error: any Error) -> String {
        (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
    }
}
