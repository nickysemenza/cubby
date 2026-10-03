import CubbyKit
import Foundation
import Observation
import SwiftUI

/// The load/phase seam every specialist layout (calendar, board, gallery, analytics) shares:
/// the manifest names the layout id, the layout supplies only its fetch and its rows.
@MainActor @Observable
private final class SpecialistLoader<Value> {
    enum Phase {
        case loading
        case ready(Value)
        case failed(String)
    }

    private(set) var phase: Phase = .loading
    private var filters = EntityFilterState()
    private var fetch: (@MainActor (EntityFilterState) async throws -> Value)?

    func load(
        filters: EntityFilterState, fetch: @escaping @MainActor (EntityFilterState) async throws -> Value
    ) async {
        self.filters = filters
        self.fetch = fetch
        phase = .loading
        do {
            phase = .ready(try await fetch(filters))
        } catch {
            phase = .failed(error.userMessage)
        }
    }

    func reload() async {
        guard let fetch else { return }
        await load(filters: filters, fetch: fetch)
    }

    /// Runs a mutation, then re-fetches; a failure replaces the screen with the raw error.
    func perform(_ action: @MainActor () async throws -> Void) async {
        do {
            try await action()
            await reload()
        } catch {
            phase = .failed(error.userMessage)
        }
    }
}

/// The declared list slots native draws. Exactly the slots `packages/schemas/src/native-coverage.ts`
/// marks `implemented`; `NativeCoverageViewPathTests` fails when the two sets differ.
enum ListSlotRegistry {
    typealias Builder = @MainActor (_ client: CubbyClient, _ filters: EntityFilterState) -> AnyView

    @MainActor
    static let builders: [EntityListSlotID: Builder] = [
        .mealCalendar: { AnyView(MealCalendarListView(client: $0, filters: $1)) },
        .taskBoard: { AnyView(TaskBoardListView(client: $0, filters: $1)) },
        .locationGallery: { AnyView(LocationGalleryListView(client: $0, filters: $1)) },
        .projectAnalytics: { AnyView(ProjectAnalyticsListView(client: $0, filters: $1)) },
        .expenseAnalytics: { AnyView(ExpenseAnalyticsListView(client: $0, filters: $1)) },
    ]
}

private struct SpecialistLoadView<Value, Content: View>: View {
    private struct ReloadKey: Hashable {
        let filters: EntityFilterState
        let extra: AnyHashable
    }

    let loadingLabel: String
    let filters: EntityFilterState
    var reloadKey: AnyHashable = 0
    let fetch: @MainActor (EntityFilterState) async throws -> Value
    @ViewBuilder let content: (Value, SpecialistLoader<Value>) -> Content
    @State private var loader = SpecialistLoader<Value>()

    var body: some View {
        Group {
            switch loader.phase {
            case .loading:
                LoadingIndicator.screen(label: loadingLabel)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't load view", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") { Task { await loader.reload() } }
                }
            case .ready(let value):
                content(value, loader)
            }
        }
        .task(id: ReloadKey(filters: filters, extra: reloadKey)) {
            await loader.load(filters: filters, fetch: fetch)
        }
        .refreshControl { await loader.reload() }
    }
}

private func wire(_ value: some Encodable) -> JSONValue {
    (try? JSONValue(encoding: value)) ?? .null
}

private func dollars(_ value: JSONValue?) -> String {
    (value?.doubleValue ?? 0).usd
}

private func isoDay(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}

private extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        Array(Set(self)).sorted { String(describing: $0) < String(describing: $1) }
    }
}

// MARK: - meal.calendar

struct MealCalendarListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var month =
        Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: .now)) ?? .now
    @State private var selectedDay = 1

    var body: some View {
        let month = month
        SpecialistLoadView(
            loadingLabel: "Loading calendar", filters: filters, reloadKey: month,
            fetch: { filters in try await Self.meals(client: client, month: month, filters: filters) }
        ) { items, _ in
            ScrollView {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.lg) {
                    monthGrid(items)
                    Panel {
                        Text("\(selectedDay) \(month.formatted(.dateTime.month(.wide)))")
                            .font(.fieldGuideTitle)
                        let meals = items.filter { contains($0, on: selectedDay) }
                        if meals.isEmpty {
                            Text("No meals planned").foregroundStyle(.secondary)
                        }
                        ForEach(meals.indices, id: \.self) { index in
                            let item = meals[index]
                            if let id = item["id"]?.stringValue {
                                NavigationLink(value: Route.entityDetail(.meal, id: id)) {
                                    HStack {
                                        VStack(alignment: .leading) {
                                            Text(item["title"]?.stringValue ?? "Meal")
                                            EntityQualityFact(key: .meal, id: id, raw: item)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(FieldGuideTokens.Space.lg)
            }
        }
        .onChange(of: month) { selectedDay = 1 }
    }

    private static func meals(
        client: CubbyClient, month: Date, filters: EntityFilterState
    ) async throws -> [JSONValue] {
        let end = Calendar.current.date(byAdding: .month, value: 1, to: month) ?? month
        let response = try await client.mealCalendar(from: isoDay(month), to: isoDay(end))
        let monthItems = wire(response)["items"]?.arrayValue ?? []
        if filters.isEmpty { return monthItems }
        let matched = try await client.listAllIDs(EntityCatalog[.meal], filters: filters)
        return monthItems.filter { $0["id"]?.stringValue.map(matched.contains) ?? false }
    }

    private func contains(_ item: JSONValue, on day: Int) -> Bool {
        let date = isoDay(Calendar.current.date(byAdding: .day, value: day - 1, to: month) ?? month)
        guard let start = item["startDate"]?.stringValue,
            let end = item["endDateExclusive"]?.stringValue
        else { return false }
        return start <= date && date < end
    }

    private func monthGrid(_ items: [JSONValue]) -> some View {
        let calendar = Calendar.current
        let count = calendar.range(of: .day, in: .month, for: month)?.count ?? 30
        let leading = (calendar.component(.weekday, from: month) - calendar.firstWeekday + 7) % 7
        let columns = Array(repeating: GridItem(.flexible()), count: 7)
        return Panel {
            HStack {
                Button("Previous month", systemImage: "chevron.left") { shift(-1) }
                    .labelStyle(.iconOnly)
                Spacer()
                Text(month.formatted(.dateTime.month(.wide).year())).font(.fieldGuideTitle)
                Spacer()
                Button("Next month", systemImage: "chevron.right") { shift(1) }
                    .labelStyle(.iconOnly)
            }
            LazyVGrid(columns: columns, spacing: FieldGuideTokens.Space.sm) {
                ForEach(0..<7, id: \.self) { offset in
                    Text(calendar.shortStandaloneWeekdaySymbols[(calendar.firstWeekday - 1 + offset) % 7])
                        .font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(0..<(leading + count), id: \.self) { slot in
                    if slot < leading {
                        Color.clear.frame(height: 44)
                    } else {
                        let day = slot - leading + 1
                        let number = items.filter { contains($0, on: day) }.count
                        Button {
                            selectedDay = day
                        } label: {
                            VStack(spacing: 2) {
                                Text("\(day)")
                                Text(number > 0 ? "\(number)" : " ")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(
                                day == selectedDay ? FieldGuideTokens.interaction.opacity(0.15) : .clear
                            )
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(day), \(number) meals")
                    }
                }
            }
        }
    }

    private func shift(_ months: Int) {
        month = Calendar.current.date(byAdding: .month, value: months, to: month) ?? month
    }
}

// MARK: - task.board

private struct TaskBoardData {
    let tasks: [JSONValue]
    let doneCount: Int
}

struct TaskBoardListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var selectedStatus = "not_started"
    @State private var laneField = "projectId"

    private let statuses = ["not_started", "later", "in_progress", "blocked", "done"]

    var body: some View {
        SpecialistLoadView(
            loadingLabel: "Loading board", filters: filters,
            fetch: { filters in
                let result = wire(try await client.taskBoard(filters: filters))
                return TaskBoardData(
                    tasks: (result["active"]?.arrayValue ?? []) + (result["recentDone"]?.arrayValue ?? []),
                    doneCount: Int(result["doneCount"]?.doubleValue ?? 0))
            }
        ) { board, loader in
            List {
                Picker("Status", selection: $selectedStatus) {
                    ForEach(statuses, id: \.self) {
                        Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0)
                    }
                }
                Picker("Lane", selection: $laneField) {
                    Text("Project").tag("projectId")
                    Text("Trade").tag("trade")
                }
                let visible = board.tasks.filter { $0["status"]?.stringValue == selectedStatus }
                let lanes = visible.map { $0[laneField]?.stringValue ?? "Unassigned" }.uniqued()
                ForEach(lanes, id: \.self) { lane in
                    let laneTasks = visible.filter {
                        ($0[laneField]?.stringValue ?? "Unassigned") == lane
                    }
                    Section(lane) {
                        ForEach(Array(laneTasks.enumerated()), id: \.offset) { index, task in
                            taskRow(task, index: index, lane: laneTasks, all: board.tasks, loader: loader)
                        }
                    }
                }
                if selectedStatus == "done" {
                    Text("\(board.doneCount) done in all; recent tasks shown")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func taskRow(
        _ task: JSONValue, index: Int, lane: [JSONValue], all: [JSONValue],
        loader: SpecialistLoader<TaskBoardData>
    ) -> some View {
        if let id = task["id"]?.stringValue {
            HStack {
                NavigationLink(value: Route.entityDetail(.task, id: id)) {
                    VStack(alignment: .leading) {
                        Text(task["name"]?.stringValue ?? id)
                        EntityQualityFact(key: .task, id: id, raw: task)
                    }
                }
                Menu("Move", systemImage: "arrow.up.arrow.down") {
                    ForEach(statuses, id: \.self) { status in
                        Button(status.replacingOccurrences(of: "_", with: " ").capitalized) {
                            Task { await move(id, field: "status", value: status, loader: loader) }
                        }
                    }
                    ForEach(all.compactMap { $0[laneField]?.stringValue }.uniqued(), id: \.self) {
                        destination in
                        Button("Lane: \(destination)") {
                            Task { await move(id, field: laneField, value: destination, loader: loader) }
                        }
                    }
                    Button("Move earlier") {
                        Task { await reorder(id, offset: -1, in: lane, loader: loader) }
                    }
                    .disabled(index == 0)
                    Button("Move later") {
                        Task { await reorder(id, offset: 1, in: lane, loader: loader) }
                    }
                    .disabled(index == lane.count - 1)
                }
            }
        }
    }

    private func move(
        _ id: String, field: String, value: String, loader: SpecialistLoader<TaskBoardData>
    ) async {
        await loader.perform {
            try await client.update(
                EntityCatalog[.task], id: id, patch: EntityPatch(values: [field: .string(value)]))
        }
    }

    private func reorder(
        _ id: String, offset: Int, in lane: [JSONValue], loader: SpecialistLoader<TaskBoardData>
    ) async {
        guard let index = lane.firstIndex(where: { $0["id"]?.stringValue == id }),
            lane.indices.contains(index + offset)
        else { return }
        var ordered = lane.compactMap { $0["id"]?.stringValue }
        guard ordered.count == lane.count else { return }
        ordered.swapAt(index, index + offset)
        await loader.perform {
            for start in stride(from: 0, to: ordered.count, by: 200) {
                let end = min(start + 200, ordered.count)
                try await client.reorderTasks((start..<end).map { (ordered[$0], Double($0 * 1024)) })
            }
        }
    }
}

// MARK: - location.gallery

struct LocationGalleryListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var type = "all"

    var body: some View {
        SpecialistLoadView(
            loadingLabel: "Loading locations", filters: filters,
            fetch: { filters in
                let tree = try await client.locationTree()
                var nodes: [LocationTreeNode] = []
                func visit(_ node: LocationTreeNode) {
                    nodes.append(node)
                    node.childNodes.forEach(visit)
                }
                tree.roots.forEach(visit)
                if filters.isEmpty { return nodes }
                let matched = try await client.listAllIDs(EntityCatalog[.location], filters: filters)
                return nodes.filter { matched.contains($0.id.rawValue) }
            }
        ) { locations, _ in
            List {
                Picker("Type", selection: $type) {
                    Text("All").tag("all")
                    ForEach(Array(Set(locations.map { $0._type.rawValue })).sorted(), id: \.self) {
                        Text($0.capitalized).tag($0)
                    }
                }
                ForEach(locations.filter { type == "all" || $0._type.rawValue == type }, id: \.id) { node in
                    NavigationLink(value: Route.entityDetail(.location, id: node.id.rawValue)) {
                        HStack {
                            let url = node.images.first.flatMap {
                                URL(string: $0.representations?.preferred ?? $0.url)
                            }
                            Thumb(url: url, size: 48, symbol: "shippingbox")
                            VStack(alignment: .leading) {
                                Text(node.name)
                                EntityQualityFact(key: .location, id: node.id.rawValue, raw: wire(node))
                                Text("\(node.totalItems) items · \(node.childNodes.count) sublocations")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - project.analytics

struct ProjectAnalyticsListView: View {
    let client: CubbyClient
    let filters: EntityFilterState

    var body: some View {
        SpecialistLoadView(
            loadingLabel: "Loading analytics", filters: filters,
            fetch: { filters in
                let (summary, analytics) = try await client.projectAnalytics(filters: filters)
                return (summary: wire(summary), analytics: wire(analytics))
            }
        ) { data, _ in
            List {
                let summary = data.summary["summary"]
                Section("Portfolio") {
                    LabeledContent(
                        "Active projects", value: "\(Int(summary?["activeProjectCount"]?.doubleValue ?? 0))")
                    LabeledContent("Open tasks", value: "\(Int(summary?["openTaskCount"]?.doubleValue ?? 0))")
                    LabeledContent("Actual spend", value: dollars(summary?["actualSpend"]))
                }
                Section("Cost against estimate") {
                    ForEach(
                        Array((data.analytics["costVsEstimate"]?.arrayValue ?? []).enumerated()),
                        id: \.offset
                    ) { _, row in
                        if let id = row["projectId"]?.stringValue {
                            NavigationLink(value: Route.entityDetail(.project, id: id)) {
                                VStack(alignment: .leading) {
                                    Text(row["projectName"]?.stringValue ?? id)
                                    Text("Actual \(dollars(row["actual"]))")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - expense.analytics

struct ExpenseAnalyticsListView: View {
    let client: CubbyClient
    let filters: EntityFilterState

    var body: some View {
        SpecialistLoadView(
            loadingLabel: "Loading analytics", filters: filters,
            fetch: { filters in wire(try await client.expenseAnalytics(filters: filters)) }
        ) { analytics, _ in
            List {
                Section("Spend") {
                    LabeledContent("Net", value: dollars(analytics["summary"]?["net"]))
                    LabeledContent(
                        "Expenses", value: "\(Int(analytics["summary"]?["count"]?.doubleValue ?? 0))")
                }
                Section("By month") {
                    ForEach(Array((analytics["monthly"]?.arrayValue ?? []).enumerated()), id: \.offset) {
                        _, row in
                        LabeledContent(row["month"]?.stringValue ?? "Month", value: dollars(row["net"]))
                    }
                }
                Section("By project") {
                    ForEach(Array((analytics["byProject"]?.arrayValue ?? []).enumerated()), id: \.offset) {
                        _, row in
                        if let id = row["projectId"]?.stringValue {
                            NavigationLink(value: Route.entityDetail(.project, id: id)) {
                                LabeledContent(
                                    row["projectName"]?.stringValue ?? id, value: dollars(row["net"]))
                            }
                        }
                    }
                }
            }
        }
    }
}
