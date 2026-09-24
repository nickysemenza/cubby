import CubbyKit
import Foundation
import Observation
import SwiftUI

private enum SpecialistPhase: Equatable { case loading, ready, failed(String) }

private func specialistError(_ error: Error) -> String {
    (error as? CubbyAPIError)?.detail?.message ?? String(describing: error)
}

private func wire(_ value: some Encodable) -> JSONValue {
    (try? JSONValue(encoding: value)) ?? .null
}

private func dollars(_ value: JSONValue?) -> String {
    (value?.doubleValue ?? 0).formatted(.currency(code: "USD"))
}

@MainActor @Observable
private final class MealCalendarModel {
    var month =
        Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: .now)) ?? .now
    private(set) var items: [JSONValue] = []
    private(set) var phase: SpecialistPhase = .loading
    private let client: CubbyClient
    private var filters = EntityFilterState()

    init(client: CubbyClient) { self.client = client }

    func load(filters: EntityFilterState) async {
        self.filters = filters
        phase = .loading
        let end = Calendar.current.date(byAdding: .month, value: 1, to: month) ?? month
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        do {
            let response = try await client.mealCalendar(
                from: formatter.string(from: month), to: formatter.string(from: end))
            let monthItems = wire(response)["items"]?.arrayValue ?? []
            if filters.isEmpty {
                items = monthItems
            } else {
                var matched: Set<String> = []
                var pageNumber = 1
                while true {
                    let page = try await client.list(
                        EntityCatalog[.meal], page: pageNumber, pageSize: 200, filters: filters)
                    matched.formUnion(page.items.map(\.id))
                    if page.items.count < 200 { break }
                    pageNumber += 1
                }
                items = monthItems.filter { $0["id"]?.stringValue.map(matched.contains) ?? false }
            }
            phase = .ready
        } catch { phase = .failed(specialistError(error)) }
    }

    func shift(_ months: Int) async {
        month = Calendar.current.date(byAdding: .month, value: months, to: month) ?? month
        await load(filters: filters)
    }
}

@MainActor @Observable
private final class TaskBoardModel {
    private(set) var tasks: [JSONValue] = []
    private(set) var doneCount = 0
    private(set) var phase: SpecialistPhase = .loading
    private let client: CubbyClient
    private var filters: EntityFilterState

    init(client: CubbyClient, filters: EntityFilterState) {
        self.client = client
        self.filters = filters
    }

    func load(filters: EntityFilterState) async {
        self.filters = filters
        phase = .loading
        do {
            let result = wire(try await client.taskBoard(filters: filters))
            tasks = (result["active"]?.arrayValue ?? []) + (result["recentDone"]?.arrayValue ?? [])
            doneCount = Int(result["doneCount"]?.doubleValue ?? 0)
            phase = .ready
        } catch { phase = .failed(specialistError(error)) }
    }

    func move(_ id: String, field: String, value: String) async {
        do {
            try await client.update(
                EntityCatalog[.task], id: id,
                patch: EntityPatch(values: [field: .string(value)]))
            await load(filters: filters)
        } catch { phase = .failed(specialistError(error)) }
    }

    func reorder(_ id: String, offset: Int, in lane: [JSONValue]) async {
        guard let index = lane.firstIndex(where: { $0["id"]?.stringValue == id }),
            lane.indices.contains(index + offset)
        else { return }
        var ordered = lane.compactMap { $0["id"]?.stringValue }
        guard ordered.count == lane.count else { return }
        ordered.swapAt(index, index + offset)
        do {
            for start in stride(from: 0, to: ordered.count, by: 200) {
                let end = min(start + 200, ordered.count)
                try await client.reorderTasks(
                    (start..<end).map { (ordered[$0], Double($0 * 1024)) })
            }
            await load(filters: filters)
        } catch { phase = .failed(specialistError(error)) }
    }
}

@MainActor @Observable
private final class LocationGalleryModel {
    private(set) var locations: [LocationTreeNode] = []
    private(set) var phase: SpecialistPhase = .loading
    private let client: CubbyClient

    init(client: CubbyClient) { self.client = client }

    func load(filters: EntityFilterState) async {
        phase = .loading
        do {
            let tree = try await client.locationTree()
            var nodes: [LocationTreeNode] = []
            func visit(_ node: LocationTreeNode) {
                nodes.append(node)
                node.childNodes.forEach(visit)
            }
            tree.roots.forEach(visit)
            if filters.isEmpty {
                locations = nodes
            } else {
                var matched: Set<String> = []
                var pageNumber = 1
                while true {
                    let page = try await client.list(
                        EntityCatalog[.location], page: pageNumber, pageSize: 200, filters: filters)
                    matched.formUnion(page.items.map(\.id))
                    if page.items.count < 200 { break }
                    pageNumber += 1
                }
                locations = nodes.filter { matched.contains($0.id.rawValue) }
            }
            phase = .ready
        } catch { phase = .failed(specialistError(error)) }
    }
}

@MainActor @Observable
private final class ProjectAnalyticsModel {
    private(set) var summary: JSONValue = .null
    private(set) var analytics: JSONValue = .null
    private(set) var phase: SpecialistPhase = .loading
    private let client: CubbyClient

    init(client: CubbyClient) { self.client = client }

    func load(filters: EntityFilterState) async {
        phase = .loading
        do {
            let (summary, analytics) = try await client.projectAnalytics(filters: filters)
            self.summary = wire(summary)
            self.analytics = wire(analytics)
            phase = .ready
        } catch { phase = .failed(specialistError(error)) }
    }
}

@MainActor @Observable
private final class ExpenseAnalyticsModel {
    private(set) var analytics: JSONValue = .null
    private(set) var phase: SpecialistPhase = .loading
    private let client: CubbyClient

    init(client: CubbyClient) { self.client = client }

    func load(filters: EntityFilterState) async {
        phase = .loading
        do {
            analytics = wire(try await client.expenseAnalytics(filters: filters))
            phase = .ready
        } catch { phase = .failed(specialistError(error)) }
    }
}

private struct SpecialistFailure: View {
    let phase: SpecialistPhase
    let retry: () -> Void
    var body: some View {
        switch phase {
        case .loading: LoadingIndicator.screen(label: "Loading view")
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load view", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry", action: retry)
            }
        case .ready: EmptyView()
        }
    }
}

struct MealCalendarListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var model: MealCalendarModel?
    @State private var selectedDay = 1

    var body: some View {
        Group {
            if let model {
                switch model.phase {
                case .ready:
                    ScrollView {
                        VStack(alignment: .leading, spacing: PorcelainTokens.Space.lg) {
                            monthGrid(model)
                            Panel {
                                Text("\(selectedDay) \(model.month.formatted(.dateTime.month(.wide)))")
                                    .font(.porcelainTitle)
                                let meals = model.items.filter {
                                    contains($0, on: selectedDay, in: model.month)
                                }
                                if meals.isEmpty {
                                    Text("No meals planned").foregroundStyle(.secondary)
                                }
                                ForEach(meals.indices, id: \.self) { index in
                                    let item = meals[index]
                                    if let id = item["id"]?.stringValue {
                                        NavigationLink(value: Route.entityDetail(.meal, id: id)) {
                                            HStack {
                                                Text(item["title"]?.stringValue ?? "Meal")
                                                Spacer()
                                                Image(systemName: "chevron.right")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        .padding(PorcelainTokens.Space.lg)
                    }
                case .loading, .failed:
                    SpecialistFailure(phase: model.phase) { Task { await model.load(filters: filters) } }
                }
            } else {
                LoadingIndicator.screen(label: "Loading calendar")
            }
        }
        .task(id: filters) {
            if model == nil { model = MealCalendarModel(client: client) }
            await model?.load(filters: filters)
        }
        .refreshControl { await model?.load(filters: filters) }
        .onChange(of: model?.month) { selectedDay = 1 }
    }

    private func dateString(_ month: Date, day: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: day - 1, to: month) ?? month
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func contains(_ item: JSONValue, on day: Int, in month: Date) -> Bool {
        let date = dateString(month, day: day)
        guard let start = item["startDate"]?.stringValue,
            let end = item["endDateExclusive"]?.stringValue
        else { return false }
        return start <= date && date < end
    }

    private func monthGrid(_ model: MealCalendarModel) -> some View {
        let calendar = Calendar.current
        let count = calendar.range(of: .day, in: .month, for: model.month)?.count ?? 30
        let leading = (calendar.component(.weekday, from: model.month) - calendar.firstWeekday + 7) % 7
        let columns = Array(repeating: GridItem(.flexible()), count: 7)
        return Panel {
            HStack {
                Button("Previous month", systemImage: "chevron.left") { Task { await model.shift(-1) } }
                    .labelStyle(.iconOnly)
                Spacer()
                Text(model.month.formatted(.dateTime.month(.wide).year())).font(.porcelainTitle)
                Spacer()
                Button("Next month", systemImage: "chevron.right") { Task { await model.shift(1) } }
                    .labelStyle(.iconOnly)
            }
            LazyVGrid(columns: columns, spacing: PorcelainTokens.Space.sm) {
                ForEach(0..<7, id: \.self) { offset in
                    Text(calendar.shortStandaloneWeekdaySymbols[(calendar.firstWeekday - 1 + offset) % 7])
                        .font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(0..<(leading + count), id: \.self) { slot in
                    if slot < leading {
                        Color.clear.frame(height: 44)
                    } else {
                        let day = slot - leading + 1
                        let number = model.items.filter {
                            contains($0, on: day, in: model.month)
                        }.count
                        Button {
                            selectedDay = day
                        } label: {
                            VStack(spacing: 2) {
                                Text("\(day)")
                                Text(number > 0 ? "\(number)" : " ")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(day == selectedDay ? PorcelainTokens.cobalt.opacity(0.15) : .clear)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(day), \(number) meals")
                    }
                }
            }
        }
    }
}

struct TaskBoardListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var model: TaskBoardModel?
    @State private var selectedStatus = "not_started"
    @State private var laneField = "projectId"

    private let statuses = ["not_started", "later", "in_progress", "blocked", "done"]

    var body: some View {
        Group {
            if let model {
                switch model.phase {
                case .ready:
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
                        let visible = model.tasks.filter { $0["status"]?.stringValue == selectedStatus }
                        let lanes = visible.map { $0[laneField]?.stringValue ?? "Unassigned" }.uniqued()
                        ForEach(lanes, id: \.self) { lane in
                            let laneTasks = visible.filter {
                                ($0[laneField]?.stringValue ?? "Unassigned") == lane
                            }
                            Section(lane) {
                                ForEach(Array(laneTasks.enumerated()), id: \.offset) { index, task in
                                    taskRow(task, index: index, lane: laneTasks, model: model)
                                }
                            }
                        }
                        if selectedStatus == "done" {
                            Text("\(model.doneCount) done in all; recent tasks shown")
                                .foregroundStyle(.secondary)
                        }
                    }
                case .loading, .failed:
                    SpecialistFailure(phase: model.phase) { Task { await model.load(filters: filters) } }
                }
            } else {
                LoadingIndicator.screen(label: "Loading board")
            }
        }
        .task(id: filters) {
            if model == nil { model = TaskBoardModel(client: client, filters: filters) }
            await model?.load(filters: filters)
        }
        .refreshControl { await model?.load(filters: filters) }
    }

    @ViewBuilder
    private func taskRow(
        _ task: JSONValue, index: Int, lane: [JSONValue], model: TaskBoardModel
    ) -> some View {
        if let id = task["id"]?.stringValue {
            HStack {
                NavigationLink(value: Route.entityDetail(.task, id: id)) {
                    Text(task["name"]?.stringValue ?? id)
                }
                Menu("Move", systemImage: "arrow.up.arrow.down") {
                    ForEach(statuses, id: \.self) { status in
                        Button(status.replacingOccurrences(of: "_", with: " ").capitalized) {
                            Task { await model.move(id, field: "status", value: status) }
                        }
                    }
                    ForEach(
                        model.tasks.compactMap { $0[laneField]?.stringValue }.uniqued(), id: \.self
                    ) { destination in
                        Button("Lane: \(destination)") {
                            Task { await model.move(id, field: laneField, value: destination) }
                        }
                    }
                    Button("Move earlier") {
                        Task { await model.reorder(id, offset: -1, in: lane) }
                    }
                    .disabled(index == 0)
                    Button("Move later") {
                        Task { await model.reorder(id, offset: 1, in: lane) }
                    }
                    .disabled(index == lane.count - 1)
                }
            }
        }
    }
}

private extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        Array(Set(self)).sorted { String(describing: $0) < String(describing: $1) }
    }
}

struct LocationGalleryListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var model: LocationGalleryModel?
    @State private var type = "all"

    var body: some View {
        Group {
            if let model {
                switch model.phase {
                case .ready:
                    List {
                        Picker("Type", selection: $type) {
                            Text("All").tag("all")
                            ForEach(
                                Array(Set(model.locations.compactMap { $0._type?.rawValue })).sorted(),
                                id: \.self
                            ) {
                                Text($0.capitalized).tag($0)
                            }
                        }
                        ForEach(
                            model.locations.filter { type == "all" || $0._type?.rawValue == type }, id: \.id
                        ) { node in
                            NavigationLink(value: Route.entityDetail(.location, id: node.id.rawValue)) {
                                HStack {
                                    let url = node.images.first.flatMap {
                                        URL(string: $0.representations?.preferred ?? $0.url)
                                    }
                                    Thumb(url: url, size: 48, symbol: "shippingbox")
                                    VStack(alignment: .leading) {
                                        Text(node.name)
                                        Text(
                                            "\(node.totalItems) items · \(node.childNodes.count) sublocations"
                                        )
                                        .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                case .loading, .failed:
                    SpecialistFailure(phase: model.phase) { Task { await model.load(filters: filters) } }
                }
            } else {
                LoadingIndicator.screen(label: "Loading locations")
            }
        }
        .task(id: filters) {
            if model == nil { model = LocationGalleryModel(client: client) }
            await model?.load(filters: filters)
        }
        .refreshControl { await model?.load(filters: filters) }
    }
}

struct ProjectAnalyticsListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var model: ProjectAnalyticsModel?

    var body: some View {
        Group {
            if let model {
                switch model.phase {
                case .ready:
                    List {
                        let summary = model.summary["summary"]
                        Section("Portfolio") {
                            LabeledContent(
                                "Active projects",
                                value: "\(Int(summary?["activeProjectCount"]?.doubleValue ?? 0))")
                            LabeledContent(
                                "Open tasks", value: "\(Int(summary?["openTaskCount"]?.doubleValue ?? 0))")
                            LabeledContent(
                                "Actual spend",
                                value: dollars(summary?["actualSpend"])
                            )
                        }
                        Section("Cost against estimate") {
                            ForEach(
                                Array((model.analytics["costVsEstimate"]?.arrayValue ?? []).enumerated()),
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
                case .loading, .failed:
                    SpecialistFailure(phase: model.phase) { Task { await model.load(filters: filters) } }
                }
            } else {
                LoadingIndicator.screen(label: "Loading analytics")
            }
        }
        .task(id: filters) {
            if model == nil { model = ProjectAnalyticsModel(client: client) }
            await model?.load(filters: filters)
        }
        .refreshControl { await model?.load(filters: filters) }
    }
}

struct ExpenseAnalyticsListView: View {
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var model: ExpenseAnalyticsModel?

    var body: some View {
        Group {
            if let model {
                switch model.phase {
                case .ready:
                    List {
                        Section("Spend") {
                            LabeledContent(
                                "Net",
                                value: dollars(model.analytics["summary"]?["net"])
                            )
                            LabeledContent(
                                "Expenses",
                                value: "\(Int(model.analytics["summary"]?["count"]?.doubleValue ?? 0))")
                        }
                        Section("By month") {
                            ForEach(
                                Array((model.analytics["monthly"]?.arrayValue ?? []).enumerated()),
                                id: \.offset
                            ) { _, row in
                                LabeledContent(
                                    row["month"]?.stringValue ?? "Month",
                                    value: dollars(row["net"]))
                            }
                        }
                        Section("By project") {
                            ForEach(
                                Array((model.analytics["byProject"]?.arrayValue ?? []).enumerated()),
                                id: \.offset
                            ) { _, row in
                                if let id = row["projectId"]?.stringValue {
                                    NavigationLink(value: Route.entityDetail(.project, id: id)) {
                                        LabeledContent(
                                            row["projectName"]?.stringValue ?? id,
                                            value:
                                                dollars(row["net"])
                                        )
                                    }
                                }
                            }
                        }
                    }
                case .loading, .failed:
                    SpecialistFailure(phase: model.phase) { Task { await model.load(filters: filters) } }
                }
            } else {
                LoadingIndicator.screen(label: "Loading analytics")
            }
        }
        .task(id: filters) {
            if model == nil { model = ExpenseAnalyticsModel(client: client) }
            await model?.load(filters: filters)
        }
        .refreshControl { await model?.load(filters: filters) }
    }
}
