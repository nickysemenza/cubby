import CubbyKit
import SwiftUI

struct WorkRootView: View {
    var body: some View { TodayView() }
}

@MainActor @Observable
final class WorkHighlightsModel {
    private(set) var entries: [AuditLogEntryOut] = []
    private(set) var error: String?

    init(entries: [AuditLogEntryOut] = [], error: String? = nil) {
        self.entries = entries
        self.error = error
    }

    func refresh(client: CubbyClient) async {
        do {
            entries = try await client.auditHistory(limit: 6).entries
            error = nil
        } catch {
            self.error = error.userMessage
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
                            DateDisplay(date: update.createdAt)
                                .font(.caption2).foregroundStyle(.secondary)
                            AuditChangeLines(entry: update)
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
            #if os(iOS)
                DateDisplay(date: entry.createdAt)
            #endif
        } supplement: {
            #if os(macOS)
                DateDisplay(date: entry.createdAt)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            #else
                EmptyView()
            #endif
        }
    }
}

/// An update's diff at a glance: the first two changed fields inline, the rest counted.
struct AuditChangeLines: View {
    let entry: AuditLogEntryOut

    var body: some View {
        let count = entry.changedFieldCount
        let effects = entry.identifierEffects
        let changes = Array(
            entry.fieldChanges(prefix: effects.isEmpty ? 2 : 3).filter {
                effects.isEmpty || $0.field != "externalIds"
            }.prefix(2))
        let omitted = count - changes.count - (effects.isEmpty ? 0 : 1)
        VStack(alignment: .leading, spacing: 2) {
            ForEach(changes, id: \.field) { change in
                Text("\(change.label): \(change.from ?? "(empty)") → \(change.to ?? "(empty)")")
                    .lineLimit(1)
            }
            ForEach(effects, id: \.self) { effect in
                Text(effect).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            if omitted > 0 {
                Text("\(omitted) more \(omitted == 1 ? "field" : "fields")")
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
    @State private var creation: Creation?

    private enum Creation: String, Identifiable {
        case task, meal
        var id: String { rawValue }
        var key: EntityKey { self == .task ? .task : .meal }
    }

    var body: some View {
        Group {
            if let today {
                let nutrition = nutrition
                TodayContent(
                    dateText: displayDate,
                    tasks: today.tasks, meals: today.meals,
                    taskCommands: today.taskCommands,
                    nutrition: nutrition?.state ?? .loading,
                    nutritionDay: householdDay,
                    onRefresh: {
                        async let changesRefresh: Void = highlights.refresh(client: model.client)
                        if let nutrition {
                            async let todayRefresh: Void = today.refresh()
                            async let nutritionRefresh: Void = nutrition.refresh()
                            _ = await (todayRefresh, nutritionRefresh)
                        } else {
                            await today.refresh()
                        }
                        await changesRefresh
                    },
                    tasksError: today.tasksError, mealsError: today.mealsError,
                    nutritionError: nutrition?.refreshError,
                    onRetryTasks: { await today.refreshTasks() },
                    onRetryMeals: { await today.refreshMeals() },
                    onRetryNutrition: { await nutrition?.refresh() },
                    tasksIsLoading: today.tasksIsLoading,
                    mealsIsLoading: today.mealsIsLoading,
                    nutritionIsLoading: nutrition?.isLoading ?? false,
                    highlights: highlights
                )
            } else {
                LoadingIndicator.screen(label: "Loading Today")
            }
        }
        .navigationTitle("Today")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("New task", systemImage: "checklist") { creation = .task }
                    Button("Log meal", systemImage: "fork.knife") { creation = .meal }
                    Button("Capture", systemImage: "barcode.viewfinder") {
                        model.navigator.section = .capture
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add")
                .accessibilityIdentifier("today.add")
            }
        }
        .sheet(item: $creation) { creation in
            EntityEditorSheet(
                key: creation.key,
                mode: .create(
                    prefill: creation == .task
                        ? ["due": .object(["start": .string(HouseholdDay.string(for: .now)), "end": .null])]
                        : [:])
            ) { _ in
                Task { await synchronizeDay(forceRefresh: true) }
            }
        }
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
    let tasks: TodaySectionState<EntityReportOut>
    let meals: TodaySectionState<[EntityRow]>
    /// Runs the briefing rows' commands; nil (previews) draws them inert.
    var taskCommands: ReportSlotModel? = nil
    var nutrition: TodaySectionState<MealNutritionOut> = .loading
    var nutritionDay = HouseholdDay.string(for: .now)
    let onRefresh: @Sendable () async -> Void
    var tasksError: String?
    var mealsError: String?
    var nutritionError: String?
    var onRetryTasks: (@Sendable () async -> Void)?
    var onRetryMeals: (@Sendable () async -> Void)?
    var onRetryNutrition: (@Sendable () async -> Void)?
    var tasksIsLoading = false
    var mealsIsLoading = false
    var nutritionIsLoading = false
    var highlights: WorkHighlightsModel?
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    #if os(iOS)
        @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @State private var macDashboardWidth: CGFloat = 0

    var body: some View {
        Group {
            if let message = TodayModel.failureMessage(
                tasks: tasks, meals: meals, nutrition: nutrition,
                changesError: highlights?.entries.isEmpty == true ? highlights?.error : nil)
            {
                LoadFailureView(title: "Couldn’t load Today", message: message, retry: onRefresh)
            } else {
                #if os(macOS)
                    macDashboard
                #else
                    iOSList
                #endif
            }
        }
        .navigationSubtitle(dateText)
    }

    #if os(iOS)
        private var iOSList: some View {
            List {
                ForEach(TodaySection.allCases) { section in
                    Section(section.rawValue) {
                        switch section {
                        case .tasks: taskContent
                        case .activity: activityLinks.accessibilityIdentifier("work.activityInbox")
                        case .meals: mealContent
                        case .nutrition: nutritionContent
                        case .changes: recentChanges.accessibilityIdentifier("work.auditFeed")
                        case .views: PinnedViewLinks()
                        }
                    }
                }
                Section { problemsLink }
            }
            .listRowInsets(
                EdgeInsets(
                    top: 0, leading: FieldGuideTokens.Space.md,
                    bottom: 0, trailing: FieldGuideTokens.Space.md)
            )
            .environment(\.defaultMinListRowHeight, FieldGuideTokens.touchTarget)
            .refreshControl(onRefresh)
            .accessibilityIdentifier("today.sections")
            .frame(maxWidth: horizontalSizeClass == .regular ? 760 : .infinity)
            .frame(maxWidth: .infinity)
            .background(FieldGuideTokens.canvas)
        }
    #endif

    @ViewBuilder private var taskContent: some View {
        switch tasks {
        case .loading: loadingRow("Loading tasks")
        case .failed(let message):
            InlineLoadFailure(
                message: message, isRetrying: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
        case .loaded(let briefing):
            let presentation = TodayBriefingPresentation(briefing)
            ReportBlocksView(report: ReportPresentation(presentation.tasks), model: taskCommands)
            ForEach(presentation.moreReady, id: \.self) { footer in
                NavigationLink(value: Route.entityList(.task)) {
                    Text(footer)
                }
            }
            #if os(macOS)
                if !presentation.stats.blocks.isEmpty {
                    Divider()
                    ReportBlocksView(report: ReportPresentation(presentation.stats))
                }
            #endif
        }
        if let tasksError {
            InlineLoadFailure(
                message: tasksError, isRetrying: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
        }
        if let failure = taskCommands?.actionError {
            Text(failure).font(.caption).foregroundStyle(FieldGuideTokens.destructive)
        }
    }

    @ViewBuilder private var activityLinks: some View {
        #if os(macOS)
            Button("All activity", systemImage: "clock.arrow.circlepath") {
                model.navigator.section = .activity
            }
        #else
            NavigationLink(value: Route.activityList) {
                Label("All activity", systemImage: "clock.arrow.circlepath")
            }
        #endif
        NavigationLink(value: Route.entityList(.run, savedView: "attention")) {
            Label("Runs needing attention", systemImage: "exclamationmark.circle")
        }
        NavigationLink(value: Route.entityList(.imageJob, savedView: "attention")) {
            Label("Image jobs needing attention", systemImage: "photo.badge.checkmark")
        }
    }

    @ViewBuilder private var mealContent: some View {
        switch meals {
        case .loading: loadingRow("Loading meals")
        case .failed(let message):
            InlineLoadFailure(
                message: message, isRetrying: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
        case .loaded(let rows):
            if rows.isEmpty { emptyStateText("No meals planned") }
            ForEach(rows) { meal in
                NavigationLink(value: Route.entityDetail(.meal, id: meal.id)) { mealRow(meal) }
            }
        }
        if let mealsError {
            InlineLoadFailure(
                message: mealsError, isRetrying: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
        }
    }

    @ViewBuilder private var nutritionContent: some View {
        switch nutrition {
        case .loading: loadingRow("Loading nutrition")
        case .failed(let message):
            InlineLoadFailure(
                message: message, isRetrying: nutritionIsLoading, retry: onRetryNutrition ?? onRefresh)
        case .loaded(let summary):
            MealNutritionCompactView(summary: summary)
            NavigationLink(value: Route.nutrition(day: nutritionDay)) {
                Label("View food breakdown", systemImage: "chart.bar.doc.horizontal")
            }
        }
        if let nutritionError {
            InlineLoadFailure(
                message: nutritionError, isRetrying: nutritionIsLoading, retry: onRetryNutrition ?? onRefresh)
        }
    }

    @ViewBuilder private var recentChanges: some View {
        ForEach(AuditEntryFolding.fold(highlights?.entries ?? [])) { group in
            AuditEntryRow(group: group)
        }
        NavigationLink(value: Route.auditHistory) { Label("All changes", systemImage: "clock") }
        if let error = highlights?.error {
            InlineLoadFailure(message: error, retry: onRefresh)
        }
    }

    private var problemsLink: some View {
        OpenOnWebButton(target: .route(path: "/problems")) {
            HStack {
                Label("Problems on web", systemImage: "safari")
                Spacer()
                Image(systemName: "arrow.up.right").foregroundStyle(.secondary)
            }
        }
    }

    #if os(macOS)
        private var macDashboard: some View {
            ScrollView {
                Group {
                    if dynamicTypeSize.isAccessibilitySize || macDashboardWidth < 760 {
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                            macLeftColumn
                            macRightColumn
                        }
                    } else {
                        HStack(alignment: .top, spacing: FieldGuideTokens.Space.lg) {
                            macLeftColumn.frame(maxWidth: .infinity, alignment: .topLeading)
                            macRightColumn.frame(maxWidth: .infinity, alignment: .topLeading)
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

        private var macLeftColumn: some View {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                dashboardPanel("Next up", systemImage: "checklist") { taskContent }
                dashboardPanel("Activity inbox", systemImage: "clock.arrow.circlepath") { activityLinks }
                dashboardPanel("Your views", systemImage: "pin") { PinnedViewLinks() }
                problemsLink
            }
        }

        private var macRightColumn: some View {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                dashboardPanel("Meals today", systemImage: "fork.knife") { mealContent }
                dashboardPanel("Nutrition today", systemImage: "chart.bar.doc.horizontal") {
                    nutritionContent
                }
                dashboardPanel("Recent changes", systemImage: "clock") { recentChanges }
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

    /// Home-pinned saved views from the manifest (`pin.surface == "home"`), one link per view into
    /// its entity's generic list with the view's filters, sort and list view applied.
    private struct PinnedViewLinks: View {
        private let pinned = EntityCatalog.pinnedSavedViews(surface: "home")

        var body: some View {
            ForEach(pinned) { item in
                NavigationLink(value: Route.entityList(item.entity, savedView: item.savedView.id)) {
                    Label(item.savedView.label, systemImage: EntityCatalog[item.entity].sfSymbol)
                }
                .accessibilityLabel("\(item.savedView.label), \(EntityCatalog[item.entity].plural)")
                .accessibilityIdentifier("today.pinned.\(item.id)")
            }
        }
    }

    /// Matches the shared record row's `touchTarget` minHeight so a section's
    /// loading placeholder doesn't collapse to a single text line and then jump taller once its
    /// first real row replaces it.
    private func loadingRow(_ label: String) -> some View {
        LoadingIndicator(label: label)
            .frame(minHeight: FieldGuideTokens.touchTarget, alignment: .leading)
    }

    private func mealRow(_ meal: EntityRow) -> some View {
        EntityRowView(key: .meal, row: meal, columns: ["mealType", "recipeNames"])
    }

    /// House style for a section's empty/placeholder line (`.fieldGuideLabel` + secondary), shared
    /// so every Today section's "nothing here" text reads at the same size instead of some
    /// rendering at the default body size and others at caption size.
    private func emptyStateText(_ text: String) -> some View {
        Text(text).font(.fieldGuideLabel).foregroundStyle(.secondary)
    }
}

#Preview("Today", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loaded(PreviewFixtures.sampleTodayBriefing),
            meals: .loaded(PreviewFixtures.sampleTodayMeals),
            nutrition: .loaded(PreviewFixtures.sampleMealNutrition),
            nutritionDay: "2026-09-14",
            onRefresh: {},
            highlights: WorkHighlightsModel(
                entries: [
                    AuditLogEntryOut(
                        entryKey: "synthetic-change", entityKind: .product,
                        entityId: "PRD-2345", canonicalEntityId: nil, entityName: "Sample Product",
                        displayImage: nil, action: .update, changes: nil,
                        references: [:], userId: "synthetic-user",
                        channel: .web, oauthClient: nil, device: nil, runId: nil, createdAt: .now, user: nil)
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
                EntityReportOut(blocks: [])),
            meals: .loaded([]),
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
            nutrition: .failed("Nutrition is temporarily unavailable."),
            onRefresh: {}
        )
        .navigationTitle("Today")
    }
}

#Preview("Today — all failed", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .failed("TEST: Still offline"), meals: .failed("TEST: Still offline"),
            nutrition: .failed("TEST: Still offline"), onRefresh: {},
            highlights: WorkHighlightsModel(error: "TEST: Still offline")
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
                nutrition: .loaded(PreviewFixtures.sampleMealNutrition),
                onRefresh: {},
                highlights: WorkHighlightsModel())
        }
        .frame(width: 1240, height: 900)
        .environment(PreviewFixtures.signedInModel())
    }
#endif
