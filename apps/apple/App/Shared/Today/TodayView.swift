import CubbyKit
import SwiftUI

struct WorkRootView: View {
    var body: some View { TodayView() }
}

@MainActor @Observable
final class WorkHighlightsModel {
    private(set) var runs: [ActivityRun] = []
    private(set) var entries: [AuditLogEntryOut] = []
    private(set) var error: String?

    init(runs: [ActivityRun] = [], entries: [AuditLogEntryOut] = [], error: String? = nil) {
        self.runs = runs
        self.entries = entries
        self.error = error
    }

    func refresh(client: CubbyClient) async {
        do {
            async let runPage = client.activityRuns(limit: 4)
            async let auditPage = client.auditHistory(limit: 6)
            runs = try await runPage.items
            entries = try await auditPage.entries
            error = nil
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "work.highlights")
        }
    }
}

@MainActor @Observable
final class AuditHistoryModel {
    private(set) var entries: [AuditLogEntryOut] = []
    private(set) var cursor: String?
    private(set) var loading = false
    private(set) var error: String?

    func load(client: CubbyClient, reset: Bool = false) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.auditHistory(cursor: reset ? nil : cursor)
            if reset {
                entries = page.entries
            } else {
                let known = Set(entries.map(\.entryKey))
                entries += page.entries.filter { !known.contains($0.entryKey) }
            }
            cursor = page.nextCursor
            error = nil
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "audit.history")
        }
    }
}

struct AuditHistoryView: View {
    @Environment(AppModel.self) private var appModel
    @State private var history = AuditHistoryModel()

    var body: some View {
        List {
            if let error = history.error {
                LoadFailureView(title: "Couldn’t load changes", message: error) {
                    await history.load(client: appModel.client, reset: true)
                }
            }
            ForEach(AuditEntryFolding.fold(history.entries)) { AuditEntryRow(group: $0) }
            if history.entries.isEmpty && !history.loading && history.error == nil {
                ContentUnavailableView("No changes yet", systemImage: "clock")
            }
            if history.cursor != nil {
                Button("Load more") { Task { await history.load(client: appModel.client) } }
                    .disabled(history.loading)
            }
        }
        .listRowInsets(
            EdgeInsets(
                top: 0, leading: FieldGuideTokens.Space.md,
                bottom: 0, trailing: FieldGuideTokens.Space.md)
        )
        .navigationTitle("Changes")
        .task(id: appModel.host) { await history.load(client: appModel.client, reset: true) }
        .refreshable { await history.load(client: appModel.client, reset: true) }
    }
}

/// One audit event: a single entry, or a folded burst of updates to one record by one writer
/// ("3 updates · 2 fields") that expands to each update's changes.
struct AuditEntryRow: View {
    let group: AuditEntryGroup
    @Environment(AppModel.self) private var appModel

    private var entry: AuditLogEntryOut { group.lead }

    private var record: RecordSelection? {
        guard entry.action != .delete,
            let key = EntityKey(rawValue: entry.entityKind.rawValue),
            let id = entry.canonicalEntityId ?? entry.entityId
        else { return nil }
        return RecordSelection(key: key, id: id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Group {
                if let record {
                    Button {
                        appModel.navigator.openRecord(record)
                    } label: {
                        content
                    }
                    .buttonStyle(.borderless)
                    .tint(.primary)
                } else {
                    content
                }
            }
            .accessibilityElement(children: .combine)
            if group.isFolded {
                DisclosureGroup("Show \(group.entries.count) updates") {
                    ForEach(group.entries, id: \.entryKey) { update in
                        VStack(alignment: .leading, spacing: 2) {
                            RecordRowTimestamp(date: update.createdAt)
                                .font(.caption2).foregroundStyle(.secondary)
                            AuditChangeLines(changes: update.fieldChanges)
                        }
                    }
                }
                .font(.caption)
            }
        }
        .listRowInsets(
            EdgeInsets(
                top: 0, leading: FieldGuideTokens.Space.md,
                bottom: 0, trailing: FieldGuideTokens.Space.md)
        )
    }

    private var content: some View {
        RecordListRow(
            title: entry.entityName ?? entry.entityKind.rawValue.capitalized,
            imageURL: entry.displayImage.flatMap { URL(string: $0.representations?.preferred ?? $0.url) },
            symbol: EntityKey(rawValue: entry.entityKind.rawValue).map { EntityCatalog[$0].sfSymbol }
                ?? "clock.arrow.circlepath"
        ) {
            Text(
                EntityKey(rawValue: entry.entityKind.rawValue).map { EntityCatalog[$0].singular }
                    ?? entry.entityKind.rawValue)
        } rail: {
            Text(group.foldSummary ?? entry.action.rawValue.capitalized)
            RecordRowTimestamp(date: entry.createdAt)
        } supplement: {
            if !group.isFolded, entry.action == .update {
                AuditChangeLines(changes: entry.fieldChanges)
            }
        }
    }
}

/// An update's diff at a glance: the first two changed fields inline, the rest counted.
struct AuditChangeLines: View {
    let changes: [AuditFieldChange]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(changes.prefix(2), id: \.field) { change in
                Text("\(change.label): \(change.from ?? "(empty)") → \(change.to ?? "(empty)")")
                    .lineLimit(1)
            }
            if changes.count > 2 {
                Text("\(changes.count - 2) more \(changes.count == 3 ? "field" : "fields")")
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
    }
}

struct TodayView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var today: TodayModel?
    @State private var nutrition: MealNutritionModel?
    @State private var highlights = WorkHighlightsModel()
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
                    nutritionIsLoading: nutrition?.isLoading ?? false,
                    highlights: highlights
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
            if phase == .active {
                Task {
                    await synchronizeDay(forceRefresh: true)
                    await highlights.refresh(client: model.client)
                }
            }
        }
        .task(id: model.host) { await highlights.refresh(client: model.client) }
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
    var highlights: WorkHighlightsModel?
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var macDashboardWidth: CGFloat = 0

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
                Section("Activity inbox") {
                    NavigationLink(value: Route.activityList) {
                        Label("All activity", systemImage: "clock.arrow.circlepath")
                    }
                    ForEach(highlights?.runs ?? [], id: \.id) { run in
                        Button {
                            model.navigator.openActivity(.serverRun(run.id))
                        } label: {
                            ActivityRunRow(run: run)
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(
                            EdgeInsets(
                                top: 0, leading: FieldGuideTokens.Space.md,
                                bottom: 0, trailing: FieldGuideTokens.Space.md))
                    }
                    if highlights?.runs.isEmpty == true {
                        emptyStateText("No recent runs")
                    }
                }
                .accessibilityIdentifier("work.activityInbox")
                Section("Recent changes") {
                    ForEach(AuditEntryFolding.fold(highlights?.entries ?? [])) { group in
                        AuditEntryRow(group: group)
                    }
                    NavigationLink(value: Route.auditHistory) {
                        Label("All changes", systemImage: "clock")
                    }
                    if let error = highlights?.error {
                        Text(error).font(.caption).foregroundStyle(FieldGuideTokens.warning)
                    }
                }
                .accessibilityIdentifier("work.auditFeed")
                Section("Next up") {
                    switch tasks {
                    case .loading: loadingRow("Loading tasks")
                    case .failed(let message):
                        InlineLoadFailure(
                            message: message, isRetrying: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                    case .loaded(let briefing):
                        nextUpEmptyState(briefing)
                        ForEach(briefing.next) { task in
                            NavigationLink(value: Route.entityDetail(.task, id: task.id)) {
                                taskRow(task)
                            }
                        }
                    }
                    if let tasksError {
                        InlineLoadFailure(
                            message: tasksError, isRetrying: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                    }
                }
                Section("Meals today") {
                    switch meals {
                    case .loading: loadingRow("Loading meals")
                    case .failed(let message):
                        InlineLoadFailure(
                            message: message, isRetrying: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                    case .loaded(let rows):
                        if rows.isEmpty { emptyStateText("No meals planned") }
                        ForEach(rows) { meal in
                            NavigationLink(value: Route.entityDetail(.meal, id: meal.id)) {
                                mealRow(meal)
                            }
                        }
                    }
                    if let mealsError {
                        InlineLoadFailure(
                            message: mealsError, isRetrying: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                    }
                }
                Section("Nutrition today") {
                    switch nutrition {
                    case .loading: loadingRow("Loading nutrition")
                    case .failed(let message):
                        InlineLoadFailure(
                            message: message, isRetrying: nutritionIsLoading,
                            retry: onRetryNutrition ?? onRefresh)
                    case .loaded(let summary):
                        MealNutritionCompactView(summary: summary)
                        NavigationLink(value: Route.nutrition(day: nutritionDay)) {
                            Label("View food breakdown", systemImage: "chart.bar.doc.horizontal")
                        }
                    }
                    if let nutritionError {
                        InlineLoadFailure(
                            message: nutritionError, isRetrying: nutritionIsLoading,
                            retry: onRetryNutrition ?? onRefresh)
                    }
                }
                Section("Status") {
                    switch problems {
                    case .loading: loadingRow("Loading problems")
                    case .failed(let message):
                        InlineLoadFailure(
                            message: message, isRetrying: problemsIsLoading,
                            retry: onRetryProblems ?? onRefresh)
                    case .loaded(let counts):
                        Text(
                            "\(counts.total.formatted()) problems · \(counts.coverageTotal.formatted()) coverage gaps"
                        )
                        .font(.fieldGuideLabel)
                        .foregroundStyle(.secondary)
                    }
                    if let problemsError {
                        InlineLoadFailure(
                            message: problemsError, isRetrying: problemsIsLoading,
                            retry: onRetryProblems ?? onRefresh)
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
            .listRowInsets(
                EdgeInsets(
                    top: 0, leading: FieldGuideTokens.Space.md,
                    bottom: 0, trailing: FieldGuideTokens.Space.md)
            )
            .environment(\.defaultMinListRowHeight, FieldGuideTokens.touchTarget)
            .refreshControl(onRefresh)
            .accessibilityIdentifier("today.sections")
            .navigationSubtitle(dateText)
        }
    #endif

    #if os(macOS)
        private var macDashboard: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xl) {
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        Text("Today").font(.fieldGuideDisplay)
                        HStack(spacing: FieldGuideTokens.Space.sm) {
                            Circle().fill(FieldGuideTokens.signal).frame(width: 9, height: 9)
                            Text(dateText).font(.fieldGuideLabel).foregroundStyle(.secondary)
                        }
                    }

                    if dynamicTypeSize.isAccessibilitySize || macDashboardWidth < 760 {
                        macDashboardStack
                    } else {
                        HStack(alignment: .top, spacing: FieldGuideTokens.Space.lg) {
                            macWorkAndActivity
                                .frame(width: macWorkWidth, alignment: .topLeading)
                            macMealsAndChanges
                                .frame(
                                    width: macDashboardWidth - macWorkWidth - FieldGuideTokens.Space.lg,
                                    alignment: .topLeading)
                        }
                    }
                }
                .frame(maxWidth: 1080, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) {
                    $0.size.width
                } action: {
                    macDashboardWidth = $0
                }
                .frame(maxWidth: .infinity, alignment: .top)
                .padding(FieldGuideTokens.Space.xxl)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background(FieldGuideTokens.canvas)
            .refreshControl(onRefresh)
            .accessibilityIdentifier("today.sections")
        }

        private var macWorkWidth: CGFloat {
            max(400, (macDashboardWidth - FieldGuideTokens.Space.lg) * 0.55)
        }

        private var macWorkAndActivity: some View {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                macWorkColumn
                if let highlights { workActivityPanel(highlights) }
            }
        }

        private var macMealsAndChanges: some View {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                macMealsColumn
                if let highlights { workAuditPanel(highlights) }
            }
        }

        private var macDashboardStack: some View {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                macWorkAndActivity
                macMealsAndChanges
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        private func workActivityPanel(_ highlights: WorkHighlightsModel) -> some View {
            dashboardPanel("Activity inbox", systemImage: "clock.arrow.circlepath") {
                Button("All activity") { model.navigator.section = .activity }
                ForEach(highlights.runs, id: \.id) { run in
                    Button {
                        model.navigator.openActivity(.serverRun(run.id))
                    } label: {
                        ActivityRunRow(run: run)
                    }
                    .buttonStyle(.plain)
                }
                if highlights.runs.isEmpty { emptyStateText("No recent runs") }
            }
        }

        private func workAuditPanel(_ highlights: WorkHighlightsModel) -> some View {
            dashboardPanel("Recent changes", systemImage: "clock") {
                ForEach(AuditEntryFolding.fold(highlights.entries)) { AuditEntryRow(group: $0) }
                NavigationLink(value: Route.auditHistory) { Text("All changes") }
                if let error = highlights.error { Text(error).foregroundStyle(FieldGuideTokens.warning) }
            }
        }

        private var macMealsColumn: some View {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                dashboardPanel("Meals today", systemImage: "fork.knife") {
                    switch meals {
                    case .loading: LoadingIndicator(label: "Loading meals")
                    case .failed(let message):
                        InlineLoadFailure(
                            message: message, isRetrying: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                    case .loaded(let rows):
                        if rows.isEmpty { emptyStateText("No meals planned") }
                        ForEach(rows) { meal in
                            NavigationLink(value: Route.entityDetail(.meal, id: meal.id)) {
                                mealRow(meal)
                            }
                        }
                    }
                    if let mealsError {
                        InlineLoadFailure(
                            message: mealsError, isRetrying: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                    }
                }

                dashboardPanel("Nutrition today", systemImage: "chart.bar.doc.horizontal") {
                    switch nutrition {
                    case .loading: LoadingIndicator(label: "Loading nutrition")
                    case .failed(let message):
                        InlineLoadFailure(
                            message: message, isRetrying: nutritionIsLoading,
                            retry: onRetryNutrition ?? onRefresh)
                    case .loaded(let summary):
                        MealNutritionCompactView(summary: summary)
                        NavigationLink(value: Route.nutrition(day: nutritionDay)) {
                            Label("View food breakdown", systemImage: "arrow.right")
                        }
                    }
                    if let nutritionError {
                        InlineLoadFailure(
                            message: nutritionError, isRetrying: nutritionIsLoading,
                            retry: onRetryNutrition ?? onRefresh)
                    }
                }
            }
        }

        private var macWorkColumn: some View {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                dashboardPanel("Next up", systemImage: "checklist") {
                    switch tasks {
                    case .loading: LoadingIndicator(label: "Loading tasks")
                    case .failed(let message):
                        InlineLoadFailure(
                            message: message, isRetrying: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                    case .loaded(let briefing):
                        nextUpEmptyState(briefing)
                        ForEach(briefing.next) { task in
                            NavigationLink(value: Route.entityDetail(.task, id: task.id)) {
                                taskRow(task)
                            }
                        }
                    }
                    if let tasksError {
                        InlineLoadFailure(
                            message: tasksError, isRetrying: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                    }
                }

                dashboardPanel("Status", systemImage: "exclamationmark.triangle") {
                    switch problems {
                    case .loading: LoadingIndicator(label: "Loading problems")
                    case .failed(let message):
                        InlineLoadFailure(
                            message: message, isRetrying: problemsIsLoading,
                            retry: onRetryProblems ?? onRefresh)
                    case .loaded(let counts):
                        Text(
                            "\(counts.total.formatted()) problems · \(counts.coverageTotal.formatted()) coverage gaps"
                        )
                        .font(.fieldGuideLabel)
                        .foregroundStyle(.secondary)
                    }
                    if let problemsError {
                        InlineLoadFailure(
                            message: problemsError, isRetrying: problemsIsLoading,
                            retry: onRetryProblems ?? onRefresh)
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
                    .font(.fieldGuideHeadline)
                    .foregroundStyle(FieldGuideTokens.graphite)
                Divider()
                content()
            }
        }
    #endif

    /// Matches the shared record row's `touchTarget` minHeight so a section's
    /// loading placeholder doesn't collapse to a single text line and then jump taller once its
    /// first real row replaces it.
    private func loadingRow(_ label: String) -> some View {
        LoadingIndicator(label: label)
            .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
    }

    /// `nil` when there is nothing overdue, due soon, blocked, or later to summarize — distinct
    /// from `briefing.next.isEmpty`, which is about the ready-now list `nextUpEmptyState` renders
    /// alongside it.
    private func taskSummary(_ briefing: TaskTodayBriefingOut) -> String? {
        let parts = [
            briefing.overdueCount > 0 ? "\(briefing.overdueCount) overdue" : nil,
            briefing.dueThisWeekCount > 0 ? "\(briefing.dueThisWeekCount) due this week" : nil,
            briefing.blockedCount > 0 ? "\(briefing.blockedCount) blocked" : nil,
            briefing.nextCount > briefing.next.count
                ? "\(briefing.nextCount - briefing.next.count) more ready" : nil,
            briefing.laterCount > 0 ? "\(briefing.laterCount) later" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func taskRow(_ task: TaskTodayBriefingItemOut) -> some View {
        RecordListRow(title: task.name, symbol: EntityCatalog[.task].sfSymbol) {
            if let project = task.projectName {
                Text([task.projectEmoji, project].compactMap { $0 }.joined(separator: " "))
            }
        } rail: {
            Text(task.status == .inProgress ? "In progress" : "Not started")
                .foregroundStyle(task.status == .inProgress ? FieldGuideTokens.interaction : Color.secondary)
            if let dueDate = task.dueDate { Text("Due \(formattedDueDate(dueDate))").monospacedDigit() }
        } supplement: {
            EmptyView()
        }
    }

    private func mealRow(_ meal: MealListItem) -> some View {
        RecordListRow(
            title: meal.displayName,
            imageURL: meal.displayImages.first.flatMap {
                URL(string: $0.representations?.preferred ?? $0.url)
            },
            symbol: EntityCatalog[.meal].sfSymbol
        ) {
            if !meal.recipeNames.isEmpty { Text(meal.recipeNames.joined(separator: ", ")) }
        } rail: {
            if let type = meal.mealType { Text(type.rawValue.capitalized) }
        } supplement: {
            EmptyView()
        }
    }

    /// One consistently-styled empty/summary line for "Next up" instead of two differently-sized
    /// messages stacked (a summary-count caption plus a body-size "nothing ready" line).
    @ViewBuilder
    private func nextUpEmptyState(_ briefing: TaskTodayBriefingOut) -> some View {
        let summary = taskSummary(briefing)
        if let summary {
            emptyStateText(summary)
        }
        if briefing.next.isEmpty {
            emptyStateText(summary == nil ? "Nothing urgent or ready right now" : "Nothing ready right now")
        }
    }

    /// House style for a section's empty/placeholder line (`.fieldGuideLabel` + secondary), shared
    /// so every Today section's "nothing here" text reads at the same size instead of some
    /// rendering at the default body size and others at caption size.
    private func emptyStateText(_ text: String) -> some View {
        Text(text).font(.fieldGuideLabel).foregroundStyle(.secondary)
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
            onRefresh: {},
            highlights: WorkHighlightsModel(
                runs: [
                    ActivityRun(
                        id: "RUN-4K7M", recordType: .run, kind: .photoInventory, subjectName: "Photo import",
                        iconEntity: .inventory, workLabel: "Photo inventory", targetPreview: [],
                        changedCount: 0,
                        state: "running", active: true, createdAt: .now,
                        attempts: 1, executors: [], hasDiagnostics: false, canRetry: false)
                ],
                entries: [
                    AuditLogEntryOut(
                        entryKey: "synthetic-change", entityKind: .product,
                        entityId: "PRD-2345", entityName: "Sample Product", action: .update,
                        userId: "synthetic-user", channel: .web, createdAt: .now)
                ])
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

    #Preview("Work — wide Mac") {
        NavigationStack {
            TodayContent(
                dateText: "Friday, September 11",
                tasks: .loaded(PreviewFixtures.sampleTodayBriefing),
                meals: .loaded(PreviewFixtures.sampleTodayMeals),
                problems: .loaded(PreviewFixtures.sampleTodayProblems),
                nutrition: .loaded(PreviewFixtures.sampleMealNutrition),
                onRefresh: {},
                highlights: WorkHighlightsModel(
                    runs: [
                        ActivityRun(
                            id: "RUN-4K7M", recordType: .run, kind: .photoInventory,
                            subjectName: "Photo import",
                            iconEntity: .inventory, workLabel: "Photo inventory", targetPreview: [],
                            changedCount: 0,
                            state: "running", active: true, createdAt: .now,
                            attempts: 1, executors: [], hasDiagnostics: false, canRetry: false)
                    ]))
        }
        .frame(width: 1240, height: 900)
        .environment(PreviewFixtures.signedInModel())
    }
#endif
