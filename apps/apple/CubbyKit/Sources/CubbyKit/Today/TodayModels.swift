/// The three shapes the Today screen renders. They live here rather than in the app target
/// because the widget and the App Intents read the same briefing.

/// One row from `task.todayBriefing`'s `next` array: an actionable task, already filtered and
/// capped by the server.
public struct TodayTask: Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    /// `not_started` or `in_progress` — the briefing only lists open work.
    public let status: String
    public let dueDate: String?
    public let dueEndDate: String?
    public let projectId: String?
    public let projectName: String?

    public init(
        id: String,
        name: String,
        status: String,
        dueDate: String? = nil,
        dueEndDate: String? = nil,
        projectId: String? = nil,
        projectName: String? = nil
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

/// One meal scoped to a day, plus the names of any recipes attached to it.
public struct TodayMeal: Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let mealType: String?
    public let mealKind: String
    public let recipeNames: [String]

    public init(
        id: String,
        name: String,
        mealType: String? = nil,
        mealKind: String = "cooked",
        recipeNames: [String] = []
    ) {
        self.id = id
        self.name = name
        self.mealType = mealType
        self.mealKind = mealKind
        self.recipeNames = recipeNames
    }
}

/// `problems.getCounts`, trimmed to the two figures Today shows.
public struct TodayProblemCounts: Sendable, Hashable {
    public let total: Int
    public let coverageTotal: Int

    public init(total: Int, coverageTotal: Int) {
        self.total = total
        self.coverageTotal = coverageTotal
    }
}
