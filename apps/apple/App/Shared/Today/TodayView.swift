import CubbyKit
import SwiftUI

/// The landing screen: what needs attention today (tasks, meals, open problems), and the ways in.
/// Each section loads independently — a failure in one never blanks the others — and the whole
/// screen supports pull-to-refresh.
struct TodayView: View {
    @Environment(AppModel.self) private var model
    @State private var today: TodayModel?

    var body: some View {
        Group {
            if let today {
                TodayContent(
                    dateText: Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()),
                    tasks: today.tasks,
                    meals: today.meals,
                    problems: today.problems,
                    onRefresh: { await today.refresh() }
                )
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .porcelainScreen()
        .navigationTitle("Today")
        .task(id: model.host) {
            let today = TodayModel(client: model.client)
            self.today = today
            await today.refresh()
        }
    }
}

/// The plain-data half of `TodayView`, so previews can feed it fixtures instead of a network call.
struct TodayContent: View {
    let dateText: String
    let tasks: TodaySectionState<[TodayTask]>
    let meals: TodaySectionState<[TodayMeal]>
    let problems: TodaySectionState<TodayProblemCounts>
    let onRefresh: @Sendable () async -> Void

    @Environment(\.sectionSelection) private var sectionSelection
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: PorcelainTokens.Space.xl) {
                Eyebrow(dateText)
                tasksSection
                mealsSection
                problemsSection
                shortcutsSection
            }
            .padding(PorcelainTokens.Space.lg)
            .frame(maxWidth: PorcelainTokens.readingWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .porcelainScreen()
        .refreshControl { await onRefresh() }
    }

    // MARK: Tasks

    @ViewBuilder
    private var tasksSection: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Tasks")
            switch tasks {
            case .loading:
                Panel { loadingRow }
            case .failed(let message):
                Panel { errorText(message) }
            case .loaded(let tasks) where tasks.isEmpty:
                Panel {
                    Text("Nothing due")
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
            case .loaded(let tasks):
                Panel(padding: 0, spacing: 0) {
                    ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                        if index > 0 { PanelDivider(inset: PorcelainTokens.Space.lg) }
                        NavigationLink(value: Route.entityDetail(.task, id: task.id)) {
                            TaskRow(task: task)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: Meals

    @ViewBuilder
    private var mealsSection: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Meals today")
            switch meals {
            case .loading:
                Panel { loadingRow }
            case .failed(let message):
                Panel { errorText(message) }
            case .loaded(let meals) where meals.isEmpty:
                Panel {
                    Text("No meals planned")
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                }
            case .loaded(let meals):
                Panel(padding: 0, spacing: 0) {
                    ForEach(Array(meals.enumerated()), id: \.element.id) { index, meal in
                        if index > 0 { PanelDivider(inset: PorcelainTokens.Space.lg) }
                        NavigationLink(value: Route.entityDetail(.meal, id: meal.id)) {
                            MealRow(meal: meal)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: Problems

    @ViewBuilder
    private var problemsSection: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Problems")
            switch problems {
            case .loading:
                Panel { loadingRow }
            case .failed(let message):
                Panel { errorText(message) }
            case .loaded(let counts):
                LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
                    StatTile(label: "Open problems", value: "\(counts.total)")
                    StatTile(label: "Coverage", value: "\(counts.coverageTotal)")
                }
            }
        }
    }

    // MARK: Shortcuts

    private var shortcutsSection: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            Eyebrow("Shortcuts")
            LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
                NavigationLink(value: Route.entityList(.product)) {
                    ActionTile(
                        title: "Browse products",
                        symbol: "shippingbox",
                        detail: "Catalog and stock"
                    )
                }
                .buttonStyle(.plain)

                shortcut(
                    to: .capture,
                    title: "Capture",
                    symbol: "barcode.viewfinder",
                    detail: "Sweep a location"
                )

                Button {
                    model.navigator.section = .capture
                    model.navigator.paths[.capture] = [.audit(locationID: nil)]
                } label: {
                    ActionTile(
                        title: "Walk the shelf",
                        symbol: "checklist",
                        detail: "Recount a bin"
                    )
                }
                .buttonStyle(.plain)

                Button {
                    model.navigator.section = .browse
                    model.navigator.paths[.browse] = [.needsPhoto(locationID: nil)]
                } label: {
                    ActionTile(
                        title: "Needs a photo",
                        symbol: "camera.badge.ellipsis",
                        detail: "Work down the backlog"
                    )
                }
                .buttonStyle(.plain)

                shortcut(
                    to: .identify,
                    title: "Identify",
                    symbol: "camera.metering.center.weighted",
                    detail: "Rank a photo"
                )
                shortcut(
                    to: .dev,
                    title: "Dev",
                    symbol: "wrench.and.screwdriver",
                    detail: "Parser and API"
                )
            }
        }
    }

    /// A tile that moves the shell's selection. Without a shell (previews) there is nothing to
    /// move, so the tile stays inert rather than pretending to navigate.
    @ViewBuilder
    private func shortcut(
        to section: AppSection,
        title: String,
        symbol: String,
        detail: String
    ) -> some View {
        Button {
            sectionSelection?.wrappedValue = section
        } label: {
            ActionTile(title: title, symbol: symbol, detail: detail)
        }
        .buttonStyle(.plain)
        .disabled(sectionSelection == nil)
    }

    // MARK: Shared section chrome

    private var loadingRow: some View {
        HStack {
            ProgressView()
            Spacer()
        }
    }

    private func errorText(_ message: String) -> some View {
        Text(message)
            .font(.porcelainLabel)
            .foregroundStyle(PorcelainTokens.destructive)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One task row: name, then project and due date as a quiet second line, with status called out
/// both by color and by word.
private struct TaskRow: View {
    let task: TodayTask

    var body: some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(task.name)
                    .font(.porcelainTitle)
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                if let subtitle {
                    Text(subtitle)
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            StatusChip(text: statusLabel, tone: statusTone)
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.md)
        .frame(minHeight: PorcelainTokens.touchTarget)
    }

    private var subtitle: String? {
        let parts = [task.projectName, task.dueDate.map(formattedDueDate)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var statusLabel: String {
        task.status == "in_progress" ? "In progress" : "Not started"
    }

    private var statusTone: StatusChip.Tone {
        task.status == "in_progress" ? .positive : .neutral
    }
}

/// One meal row: name and type, with the recipes attached to it as a quiet second line.
private struct MealRow: View {
    let meal: TodayMeal

    var body: some View {
        HStack(alignment: .top, spacing: PorcelainTokens.Space.md) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: PorcelainTokens.Space.xs) {
                    Text(meal.name)
                        .font(.porcelainTitle)
                        .foregroundStyle(PorcelainTokens.graphite)
                        .lineLimit(1)
                    if let mealType = meal.mealType {
                        Text(mealType.capitalized)
                            .font(.porcelainLabel)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                }
                if !meal.recipeNames.isEmpty {
                    Text(meal.recipeNames.joined(separator: ", "))
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
        }
        .padding(.horizontal, PorcelainTokens.Space.md)
        .padding(.vertical, PorcelainTokens.Space.md)
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

#Preview("Today") {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loaded(PreviewFixtures.sampleTodayTasks),
            meals: .loaded(PreviewFixtures.sampleTodayMeals),
            problems: .loaded(PreviewFixtures.sampleTodayProblems),
            onRefresh: {}
        )
        .navigationTitle("Today")
    }
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Today — empty") {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loaded([]),
            meals: .loaded([]),
            problems: .loaded(TodayProblemCounts(total: 0, coverageTotal: 0)),
            onRefresh: {}
        )
        .navigationTitle("Today")
    }
    .environment(PreviewFixtures.signedInModel())
}

#Preview("Today — loading and failed") {
    NavigationStack {
        TodayContent(
            dateText: "Friday, September 11",
            tasks: .loading,
            meals: .failed("The server returned an error."),
            problems: .loading,
            onRefresh: {}
        )
        .navigationTitle("Today")
    }
    .environment(PreviewFixtures.signedInModel())
}
