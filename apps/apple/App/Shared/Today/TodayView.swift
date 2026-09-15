import CubbyKit
import SwiftUI

struct TodayView: View {
    @Environment(AppModel.self) private var model
    @State private var today: TodayModel?

    var body: some View {
        Group {
            if let today {
                TodayContent(
                    dateText: Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()),
                    tasks: today.tasks, meals: today.meals, problems: today.problems,
                    onRefresh: { await today.refresh() },
                    tasksError: today.tasksError, mealsError: today.mealsError,
                    problemsError: today.problemsError,
                    onRetryTasks: { await today.refreshTasks() },
                    onRetryMeals: { await today.refreshMeals() },
                    onRetryProblems: { await today.refreshProblems() },
                    tasksIsLoading: today.tasksIsLoading,
                    mealsIsLoading: today.mealsIsLoading,
                    problemsIsLoading: today.problemsIsLoading
                )
            } else {
                LoadingIndicator.screen(label: "Loading Today")
            }
        }
        .navigationTitle("Today")
        .task(id: model.host) {
            guard today == nil else { return }
            let today = TodayModel(client: model.client)
            today.onProblemCount = { [weak model] total in model?.problemsTotal = total }
            self.today = today
            await today.refresh()
        }
    }
}

struct TodayContent: View {
    let dateText: String
    let tasks: TodaySectionState<[TodayTask]>
    let meals: TodaySectionState<[TodayMeal]>
    let problems: TodaySectionState<TodayProblemCounts>
    let onRefresh: @Sendable () async -> Void
    var tasksError: String?
    var mealsError: String?
    var problemsError: String?
    var onRetryTasks: (@Sendable () async -> Void)?
    var onRetryMeals: (@Sendable () async -> Void)?
    var onRetryProblems: (@Sendable () async -> Void)?
    var tasksIsLoading = false
    var mealsIsLoading = false
    var problemsIsLoading = false
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                Text(dateText).foregroundStyle(.secondary)
            }
            Section("Tasks") {
                switch tasks {
                case .loading: LoadingIndicator(label: "Loading tasks")
                case .failed(let message):
                    failure(message, isLoading: tasksIsLoading, retry: onRetryTasks ?? onRefresh)
                case .loaded(let rows):
                    if rows.isEmpty { Text("Nothing due").foregroundStyle(.secondary) }
                    ForEach(rows) { task in
                        NavigationLink(value: Route.entityDetail(.task, id: task.id)) { TaskRow(task: task) }
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
                        NavigationLink(value: Route.entityDetail(.meal, id: meal.id)) { MealRow(meal: meal) }
                    }
                }
                if let mealsError {
                    failure(mealsError, isLoading: mealsIsLoading, retry: onRetryMeals ?? onRefresh)
                }
            }
            Section("Problems") {
                switch problems {
                case .loading: LoadingIndicator(label: "Loading problems")
                case .failed(let message):
                    failure(message, isLoading: problemsIsLoading, retry: onRetryProblems ?? onRefresh)
                case .loaded(let counts):
                    LabeledContent("Open problems", value: counts.total.formatted())
                    LabeledContent("Coverage", value: counts.coverageTotal.formatted())
                }
                if let problemsError {
                    failure(problemsError, isLoading: problemsIsLoading, retry: onRetryProblems ?? onRefresh)
                }
            }
            Section("Shortcuts") {
                NavigationLink(value: Route.entityList(.product)) {
                    Label("Browse products", systemImage: "shippingbox")
                }
                Button {
                    model.navigator.section = .capture
                } label: {
                    Label("Capture", systemImage: "barcode.viewfinder")
                }
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
                NavigationLink(value: Route.garden) { Label("Garden", systemImage: "leaf") }
                #if os(macOS)
                    SettingsLink { Label("Settings", systemImage: "gearshape") }
                #else
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Label("Settings", systemImage: "gearshape")
                    }
                #endif
            }
        }
        .refreshControl(onRefresh)
        .accessibilityIdentifier("today.sections")
    }

    private func failure(_ message: String, isLoading: Bool, retry: @escaping @Sendable () async -> Void)
        -> some View
    {
        VStack(alignment: .leading) {
            Text(message).font(.callout).foregroundStyle(.secondary)
            if isLoading { LoadingIndicator(label: "Retrying") }
            Button("Retry") { Task { await retry() } }.disabled(isLoading)
        }
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
            tasks: .loaded(PreviewFixtures.sampleTodayTasks),
            meals: .loaded(PreviewFixtures.sampleTodayMeals),
            problems: .loaded(PreviewFixtures.sampleTodayProblems),
            onRefresh: {}
        )
        .navigationTitle("Today")
    }
}

#Preview("Today — empty", traits: .modifier(SignedInPreview())) {
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
}

#Preview("Today — loading and failed", traits: .modifier(SignedInPreview())) {
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
}
