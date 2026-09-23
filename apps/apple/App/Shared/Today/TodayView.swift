import CubbyKit
import SwiftUI

struct TodayView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var today: TodayModel?
    @State private var nutrition: MealNutritionModel?
    @State private var householdDay = HouseholdDay.string(for: .now)

    var body: some View {
        Group {
            if let today {
                let nutrition = nutrition
                TodayContent(
                    dateText: displayDate,
                    tasks: today.tasks, meals: today.meals, problems: today.problems,
                    nutrition: nutrition?.state ?? .loading,
                    nutritionDay: householdDay,
                    onRefresh: {
                        if let nutrition {
                            async let todayRefresh: Void = today.refresh()
                            async let nutritionRefresh: Void = nutrition.refresh()
                            _ = await (todayRefresh, nutritionRefresh)
                        } else {
                            await today.refresh()
                        }
                    },
                    tasksError: today.tasksError, mealsError: today.mealsError,
                    problemsError: today.problemsError,
                    nutritionError: nutrition?.refreshError,
                    onRetryTasks: { await today.refreshTasks() },
                    onRetryMeals: { await today.refreshMeals() },
                    onRetryProblems: { await today.refreshProblems() },
                    onRetryNutrition: { await nutrition?.refresh() },
                    tasksIsLoading: today.tasksIsLoading,
                    mealsIsLoading: today.mealsIsLoading,
                    problemsIsLoading: today.problemsIsLoading,
                    nutritionIsLoading: nutrition?.isLoading ?? false
                )
            } else {
                LoadingIndicator.screen(label: "Loading Today")
            }
        }
        .navigationTitle("Today")
        #if os(iOS)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
        #endif
        .task(id: model.host) {
            today = nil
            nutrition = nil
            await synchronizeDay(forceRefresh: true)
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(60))
                } catch {
                    return
                }
                await synchronizeDay()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await synchronizeDay(forceRefresh: true) } }
        }
    }

    private var displayDate: String {
        HouseholdDay.date(from: householdDay)?.formatted(
            Date.FormatStyle(date: .omitted, time: .omitted, timeZone: HouseholdDay.timeZone)
                .weekday(.wide).month(.wide).day()) ?? householdDay
    }

    /// Keeps the visible day, nutrition query, and breakdown link on one household-day value.
    /// The minute pulse handles an open foreground app; scene activation covers suspended time.
    private func synchronizeDay(forceRefresh: Bool = false) async {
        let currentDay = HouseholdDay.string(for: .now)
        let dayChanged = currentDay != householdDay
        if dayChanged { householdDay = currentDay }

        if today == nil {
            let today = TodayModel(client: model.client)
            self.today = today
        }
        if nutrition == nil || dayChanged {
            nutrition = MealNutritionModel(query: .day(currentDay), client: model.client)
        }
        guard dayChanged || forceRefresh, let today, let nutrition else { return }
        async let todayRefresh: Void = today.refresh()
        async let nutritionRefresh: Void = nutrition.refresh()
        _ = await (todayRefresh, nutritionRefresh)
    }
}

struct TodayContent: View {
    let dateText: String
    let tasks: TodaySectionState<TaskTodayBriefingOut>
    let meals: TodaySectionState<[MealListItem]>
    let problems: TodaySectionState<ProblemsCount>
    var nutrition: TodaySectionState<MealNutritionOut> = .loading
    var nutritionDay = HouseholdDay.string(for: .now)
    let onRefresh: @Sendable () async -> Void
    var tasksError: String?
    var mealsError: String?
    var problemsError: String?
    var nutritionError: String?
    var onRetryTasks: (@Sendable () async -> Void)?
    var onRetryMeals: (@Sendable () async -> Void)?
    var onRetryProblems: (@Sendable () async -> Void)?
    var onRetryNutrition: (@Sendable () async -> Void)?
    var tasksIsLoading = false
    var mealsIsLoading = false
    var problemsIsLoading = false
    var nutritionIsLoading = false
    @Environment(AppModel.self) private var model

    var body: some View {
        #if os(macOS)
            macDashboard
        #else
            iOSList
        #endif
    }

    #if os(iOS)
        private var iOSList: some View {
            List {
                Section {
                    Text(dateText).foregroundStyle(.secondary)
                }
                Section("Next up") {
                    switch tasks {
                    case .loading: LoadingIndicator(label: "Loading tasks")
                    case .failed(let message):
                        failure(message, isLoading: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                    case .loaded(let briefing):
                        Text(taskSummary(briefing))
                            .font(.porcelainLabel)
                            .foregroundStyle(.secondary)
                        if briefing.next.isEmpty {
                            Text("Nothing ready right now").foregroundStyle(.secondary)
                        }
                        ForEach(briefing.next) { task in
                            NavigationLink(value: Route.entityDetail(.task, id: task.id)) {
                                TaskRow(task: task)
                            }
                        }
                    }
                    if let tasksError {
                        failure(tasksError, isLoading: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                    }
                }
                Section("Meals today") {
                    switch meals {
                    case .loading: LoadingIndicator(label: "Loading meals")
                    case .failed(let message):
                        failure(message, isLoading: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                    case .loaded(let rows):
                        if rows.isEmpty { Text("No meals planned").foregroundStyle(.secondary) }
                        ForEach(rows) { meal in
                            NavigationLink(value: Route.entityDetail(.meal, id: meal.id)) {
                                MealRow(meal: meal)
                            }
                        }
                    }
                    if let mealsError {
                        failure(mealsError, isLoading: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                    }
                }
                Section("Nutrition today") {
                    switch nutrition {
                    case .loading: LoadingIndicator(label: "Loading nutrition")
                    case .failed(let message):
                        failure(
                            message, isLoading: nutritionIsLoading,
                            retry: onRetryNutrition ?? onRefresh)
                    case .loaded(let summary):
                        MealNutritionCompactView(summary: summary)
                        NavigationLink(value: Route.nutrition(day: nutritionDay)) {
                            Label("View food breakdown", systemImage: "chart.bar.doc.horizontal")
                        }
                    }
                    if let nutritionError {
                        failure(
                            nutritionError, isLoading: nutritionIsLoading,
                            retry: onRetryNutrition ?? onRefresh)
                    }
                }
                Section("Status") {
                    switch problems {
                    case .loading: LoadingIndicator(label: "Loading problems")
                    case .failed(let message):
                        failure(message, isLoading: problemsIsLoading, retry: onRetryProblems ?? onRefresh)
                    case .loaded(let counts):
                        Text(
                            "\(counts.total.formatted()) problems · \(counts.coverageTotal.formatted()) coverage gaps"
                        )
                        .font(.porcelainLabel)
                        .foregroundStyle(.secondary)
                    }
                    if let problemsError {
                        failure(
                            problemsError, isLoading: problemsIsLoading, retry: onRetryProblems ?? onRefresh)
                    }
                }
                Section("Quick actions") {
                    Button {
                        model.navigator.section = .capture
                        model.navigator.paths[.capture] = [.audit(locationID: nil)]
                    } label: {
                        Label("Walk the shelf", systemImage: "checklist")
                    }
                    NavigationLink(value: Route.needsPhoto(locationID: nil)) {
                        Label("Needs a photo", systemImage: "camera.badge.ellipsis")
                    }
                    Button {
                        model.navigator.openIdentify()
                    } label: {
                        Label("Identify a photo", systemImage: "camera.metering.center.weighted")
                    }
                }
            }
            .refreshControl(onRefresh)
            .accessibilityIdentifier("today.sections")
        }
    #endif

    #if os(macOS)
        private var macDashboard: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                    Text(dateText)
                        .font(.porcelainHeadline)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)

                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: PorcelainTokens.Space.lg) {
                            macWorkColumn
                                .frame(minWidth: 500, maxWidth: .infinity, alignment: .topLeading)
                            macMealsColumn
                                .frame(minWidth: 280, maxWidth: 340, alignment: .topLeading)
                        }
                        VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
                            macWorkColumn
                            macMealsColumn
                        }
                    }
                }
                .frame(maxWidth: 1080, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .top)
                .padding(PorcelainTokens.Space.xxl)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(PorcelainTokens.canvas)
            .refreshControl(onRefresh)
            .accessibilityIdentifier("today.sections")
        }

        private var macMealsColumn: some View {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
                dashboardPanel("Meals today", systemImage: "fork.knife") {
                    switch meals {
                    case .loading: LoadingIndicator(label: "Loading meals")
                    case .failed(let message):
                        failure(message, isLoading: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                    case .loaded(let rows):
                        if rows.isEmpty { Text("No meals planned").foregroundStyle(.secondary) }
                        ForEach(rows) { meal in
                            NavigationLink(value: Route.entityDetail(.meal, id: meal.id)) {
                                MealRow(meal: meal)
                            }
                        }
                    }
                    if let mealsError {
                        failure(mealsError, isLoading: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                    }
                }

                dashboardPanel("Nutrition today", systemImage: "chart.bar.doc.horizontal") {
                    switch nutrition {
                    case .loading: LoadingIndicator(label: "Loading nutrition")
                    case .failed(let message):
                        failure(
                            message, isLoading: nutritionIsLoading,
                            retry: onRetryNutrition ?? onRefresh)
                    case .loaded(let summary):
                        MealNutritionCompactView(summary: summary)
                        NavigationLink(value: Route.nutrition(day: nutritionDay)) {
                            Label("View food breakdown", systemImage: "arrow.right")
                        }
                    }
                    if let nutritionError {
                        failure(
                            nutritionError, isLoading: nutritionIsLoading,
                            retry: onRetryNutrition ?? onRefresh)
                    }
                }
            }
        }

        private var macWorkColumn: some View {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
                dashboardPanel("Next up", systemImage: "checklist") {
                    switch tasks {
                    case .loading: LoadingIndicator(label: "Loading tasks")
                    case .failed(let message):
                        failure(message, isLoading: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                    case .loaded(let briefing):
                        Text(taskSummary(briefing))
                            .font(.porcelainLabel)
                            .foregroundStyle(.secondary)
                        if briefing.next.isEmpty {
                            Text("Nothing ready right now").foregroundStyle(.secondary)
                        }
                        ForEach(briefing.next) { task in
                            NavigationLink(value: Route.entityDetail(.task, id: task.id)) {
                                TaskRow(task: task)
                            }
                        }
                    }
                    if let tasksError {
                        failure(tasksError, isLoading: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                    }
                }

                dashboardPanel("Status", systemImage: "exclamationmark.triangle") {
                    switch problems {
                    case .loading: LoadingIndicator(label: "Loading problems")
                    case .failed(let message):
                        failure(message, isLoading: problemsIsLoading, retry: onRetryProblems ?? onRefresh)
                    case .loaded(let counts):
                        Text(
                            "\(counts.total.formatted()) problems · \(counts.coverageTotal.formatted()) coverage gaps"
                        )
                        .font(.porcelainLabel)
                        .foregroundStyle(.secondary)
                    }
                    if let problemsError {
                        failure(
                            problemsError, isLoading: problemsIsLoading, retry: onRetryProblems ?? onRefresh)
                    }
                }

                dashboardPanel("Quick actions", systemImage: "arrow.up.right.square") {
                    macShortcuts
                }
            }
        }

        @ViewBuilder private var macShortcuts: some View {
            Button {
                model.navigator.section = .capture
                model.navigator.paths[.capture] = [.audit(locationID: nil)]
            } label: {
                Label("Walk the shelf", systemImage: "checklist")
            }
            NavigationLink(value: Route.needsPhoto(locationID: nil)) {
                Label("Needs a photo", systemImage: "camera.badge.ellipsis")
            }
            Button {
                model.navigator.openIdentify()
            } label: {
                Label("Identify a photo", systemImage: "camera.metering.center.weighted")
            }
        }

        private func dashboardPanel<Content: View>(
            _ title: String, systemImage: String, @ViewBuilder content: () -> Content
        ) -> some View {
            Panel {
                Label(title, systemImage: systemImage)
                    .font(.porcelainHeadline)
                    .foregroundStyle(PorcelainTokens.graphite)
                Divider()
                content()
            }
        }
    #endif

    private func failure(_ message: String, isLoading: Bool, retry: @escaping @Sendable () async -> Void)
        -> some View
    {
        VStack(alignment: .leading) {
            Text(message).font(.callout).foregroundStyle(.secondary)
            if isLoading { LoadingIndicator(label: "Retrying") }
            Button("Retry") { Task { await retry() } }.disabled(isLoading)
        }
    }

    private func taskSummary(_ briefing: TaskTodayBriefingOut) -> String {
        let parts = [
            briefing.overdueCount > 0 ? "\(briefing.overdueCount) overdue" : nil,
            briefing.dueThisWeekCount > 0 ? "\(briefing.dueThisWeekCount) due this week" : nil,
            briefing.blockedCount > 0 ? "\(briefing.blockedCount) blocked" : nil,
            briefing.nextCount > briefing.next.count
                ? "\(briefing.nextCount - briefing.next.count) more ready" : nil,
            briefing.laterCount > 0 ? "\(briefing.laterCount) later" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? "Nothing urgent is due" : parts.joined(separator: " · ")
    }
}

/// One task row: name, then project and due date as a quiet second line, with status called out
/// both by color and by word.
private struct TaskRow: View {
    let task: TaskTodayBriefingItemOut

    var body: some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(task.name)
                    .font(.porcelainTitle)
                    .foregroundStyle(PorcelainTokens.graphite)

                if let subtitle {
                    Text(subtitle)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)

                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            StatusChip(text: statusLabel, tone: statusTone)
        }
        .padding(.vertical, 4)
        .frame(minHeight: PorcelainTokens.touchTarget)
    }

    private var subtitle: String? {
        let parts = [task.projectName, task.dueDate.map(formattedDueDate)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var statusLabel: String {
        task.status == .inProgress ? "In progress" : "Not started"
    }

    private var statusTone: StatusChip.Tone {
        task.status == .inProgress ? .positive : .neutral
    }
}

/// One meal row: name and type, with the recipes attached to it as a quiet second line.
private struct MealRow: View {
    let meal: MealListItem

    var body: some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PorcelainTokens.Space.xs) {
                    Text(meal.displayName)
                        .font(.porcelainTitle)
                        .foregroundStyle(PorcelainTokens.graphite)

                    if let mealType = meal.mealType {
                        Text(mealType.rawValue.capitalized)
                            .font(.porcelainLabel)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                }
                if !meal.recipeNames.isEmpty {
                    Text(meal.recipeNames.joined(separator: ", "))
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)

                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
        }
        .padding(.vertical, 4)
        .frame(minHeight: PorcelainTokens.touchTarget)
    }
}

/// `dueDate` comes back as a calendar day (`yyyy-MM-dd`); a full timestamp is accepted too, since
/// the server contract for this field isn't pinned. Anything else prints as-is rather than hiding
/// what the server actually sent.
private func formattedDueDate(_ raw: String) -> String {
    let dayFormatter = DateFormatter()
    dayFormatter.locale = Locale(identifier: "en_US_POSIX")
    dayFormatter.dateFormat = "yyyy-MM-dd"
    if let date = dayFormatter.date(from: raw) {
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
    if let date = ISO8601DateFormatter().date(from: raw) {
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
    return raw
}

#Preview("Today", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loaded(PreviewFixtures.sampleTodayBriefing),
            meals: .loaded(PreviewFixtures.sampleTodayMeals),
            problems: .loaded(PreviewFixtures.sampleTodayProblems),
            nutrition: .loaded(PreviewFixtures.sampleMealNutrition),
            nutritionDay: "2026-09-14",
            onRefresh: {}
        )
        .navigationTitle("Today")
    }
}

#Preview("Today — empty", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loaded(
                TaskTodayBriefingOut(
                    next: [], nextCount: 0, laterCount: 0, blockedCount: 0,
                    overdueCount: 0, dueThisWeekCount: 0)),
            meals: .loaded([]),
            problems: .loaded(PreviewFixtures.sampleTodayProblems),
            nutrition: .loaded(MealNutritionOut(meals: [], people: [])),
            onRefresh: {}
        )
        .navigationTitle("Today")
    }
}

#Preview("Today — loading and failed", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loading,
            meals: .failed("The server returned an error."),
            problems: .loading,
            nutrition: .failed("Nutrition is temporarily unavailable."),
            onRefresh: {}
        )
        .navigationTitle("Today")
    }
}

#Preview("Today — dark", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loaded(PreviewFixtures.sampleTodayBriefing),
            meals: .loaded(PreviewFixtures.sampleTodayMeals),
            problems: .loaded(PreviewFixtures.sampleTodayProblems),
            nutrition: .loaded(PreviewFixtures.sampleMealNutrition),
            onRefresh: {}
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("Today — large text", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loaded(PreviewFixtures.sampleTodayBriefing),
            meals: .loaded(PreviewFixtures.sampleTodayMeals),
            problems: .loaded(PreviewFixtures.sampleTodayProblems),
            nutrition: .loaded(PreviewFixtures.sampleMealNutrition),
            onRefresh: {}
        )
    }
    .environment(\.dynamicTypeSize, .accessibility2)
}

#if os(macOS)
    #Preview("Today — narrow Mac") {
        NavigationStack {
            TodayContent(
                dateText: "Friday, September 11",
                tasks: .loaded(PreviewFixtures.sampleTodayBriefing),
                meals: .loaded(PreviewFixtures.sampleTodayMeals),
                problems: .loaded(PreviewFixtures.sampleTodayProblems),
                nutrition: .loaded(PreviewFixtures.sampleMealNutrition),
                nutritionDay: "2026-09-14",
                onRefresh: {}
            )
            .navigationTitle("Today")
        }
        .frame(width: 700, height: 900)
        .environment(PreviewFixtures.signedInModel())
    }
#endif
