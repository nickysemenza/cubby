import CubbyKit
import SwiftUI

/// One selected group bounds native reads to a summary page and one card page.
struct EntityBoardListView: View {
    let descriptor: EntityDescriptor
    let spec: BoardListSpec
    let client: CubbyClient
    let filters: EntityFilterState
    @State private var grouping = ""
    @State private var selectedGroup = ""
    @State private var page = 1
    @State private var groups: [EntityListSection] = []
    @State private var rows: [EntityRow] = []
    @State private var loading = true
    @State private var failure: String?
    @State private var writing = false
    @State private var loadToken = UUID()
    private struct Request: Hashable {
        let filters: EntityFilterState
        let grouping: String
        let selectedGroup: String
        let page: Int
    }
    private var request: Request {
        Request(filters: filters, grouping: groupBy, selectedGroup: selectedGroup, page: page)
    }

    private var groupBy: String { grouping.isEmpty ? spec.groupBy : grouping }
    private var choice: GroupChoice? { descriptor.groupChoice(groupBy) }
    private var scope: EntityFilterState { EntityBoardPlan.scope(filters, spec: spec) }
    private var current: EntityListSection? { groups.first { $0.id == selectedGroup } ?? groups.first }

    var body: some View {
        List {
            Picker(
                "Group by",
                selection: Binding(
                    get: { groupBy },
                    set: {
                        grouping = $0; selectedGroup = ""; page = 1
                    })
            ) {
                ForEach(
                    descriptor.grouping.filter { spec.groupings.contains($0.id) && $0.reason == nil },
                    id: \.id
                ) { group in
                    Text(group.label).tag(group.id)
                }
            }
            if let failure {
                InlineLoadFailure(message: failure) { await load() }
            }
            if loading { LoadingIndicator(label: "Loading board") }
            if !groups.isEmpty {
                Picker(
                    "Group",
                    selection: Binding(
                        get: { current?.id ?? "" },
                        set: {
                            selectedGroup = $0; page = 1
                        })
                ) {
                    ForEach(groups) { group in Text("\(group.label) (\(group.count))").tag(group.id) }
                }
            } else if !loading && failure == nil {
                Text("No records to show").foregroundStyle(.secondary)
            }
            if let current {
                let capped = EntityBoardPlan.isCapped(spec, groupBy: groupBy, key: current.id)
                let acceptsPlacement =
                    current.id != EntityListSection.noValueKey || choice?.filter?.noValue == true
                Section("\(current.label) · \(current.count)") {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                            NavigationLink(value: Route.entityDetail(descriptor.key, id: row.id)) {
                                EntityRowView(key: descriptor.key, row: row, columns: spec.cardFields)
                            }
                            if spec.reorder != nil {
                                Menu("Move", systemImage: "arrow.up.arrow.down") {
                                    ForEach(
                                        groups.filter {
                                            $0.id != current.id
                                                && ($0.id != EntityListSection.noValueKey
                                                    || choice?.filter?.noValue == true)
                                        }
                                    ) { destination in
                                        Button(destination.label) {
                                            Task { await move(row, to: destination) }
                                        }
                                    }
                                    if !capped && acceptsPlacement {
                                        Button("Move earlier") { Task { await reorder(index, offset: -1) } }
                                            .disabled(index == 0)
                                        Button("Move later") { Task { await reorder(index, offset: 1) } }
                                            .disabled(index == rows.count - 1)
                                    }
                                }
                                .accessibilityLabel("Move \(row.title)")
                                .disabled(writing)
                                .buttonStyle(.borderless)
                            }
                        }
                    }
                    let size = EntityBoardPlan.pageSize(spec, groupBy: groupBy, key: current.id)
                    if capped {
                        Text("\(rows.count) of \(current.count) shown").foregroundStyle(.secondary)
                    } else {
                        HStack {
                            Button("Previous") { page -= 1 }.disabled(page == 1 || loading)
                            Spacer()
                            Text("Page \(page)").monospacedDigit()
                            Button("Next") { page += 1 }.disabled(page * size >= current.count || loading)
                        }.buttonStyle(.borderless)
                    }
                }
            }
        }
        .task(id: request) { await load() }
    }

    private func load() async {
        let captured = request
        let token = UUID()
        loadToken = token
        loading = true
        rows = []
        failure = nil
        do {
            let scoped = EntityBoardPlan.scope(captured.filters, spec: spec)
            let summary = try await client.list(
                descriptor, pageSize: 1, filters: scoped, groupBy: [.init(key: captured.grouping)])
            guard !Task.isCancelled, request == captured, loadToken == token else { return }
            let summaries: [EntityListSection] = (summary.meta.groups ?? []).map {
                .init(id: $0.path.last ?? $0.key, label: $0.label, count: $0.count, path: $0.path, rows: [])
            }
            var fetchedGroups = summaries
            if let options = descriptor.field(captured.grouping)?.controlOptions, !options.isEmpty {
                fetchedGroups =
                    options.map { option in
                        summaries.first { $0.id == option.value }
                            ?? .init(id: option.value, label: option.label, count: 0, rows: [])
                    } + summaries.filter { group in !options.contains { $0.value == group.id } }
            }
            if let choice = descriptor.groupChoice(captured.grouping) {
                fetchedGroups = EntityBoardPlan.includingNoValueGroup(fetchedGroups, choice: choice)
            }
            var fetchedRows: [EntityRow] = []
            if let selected = fetchedGroups.first(where: { $0.id == captured.selectedGroup })
                ?? fetchedGroups.first,
                selected.count > 0, let choice = descriptor.groupChoice(captured.grouping),
                let cardFilters = descriptor.filtering(scoped, to: selected, of: choice)
            {
                let result = try await client.list(
                    descriptor,
                    page: EntityBoardPlan.isCapped(spec, groupBy: captured.grouping, key: selected.id)
                        ? 1 : captured.page,
                    pageSize: EntityBoardPlan.pageSize(spec, groupBy: captured.grouping, key: selected.id),
                    sort: EntityBoardPlan.sortParameter(spec, groupBy: captured.grouping, key: selected.id),
                    filters: cardFilters)
                fetchedRows = result.items
            }
            guard !Task.isCancelled, request == captured, loadToken == token else { return }
            groups = fetchedGroups
            rows = fetchedRows
            loading = false
        } catch {
            guard !Task.isCancelled, !(error is CancellationError), request == captured, loadToken == token
            else { return }
            Diagnostics.report(error, context: "Load entity board")
            failure = error.userMessage
            loading = false
        }
    }

    private func move(_ row: EntityRow, to destination: EntityListSection) async {
        guard let command = spec.reorder else { return }
        guard let choice, let destinationFilters = descriptor.filtering(scope, to: destination, of: choice)
        else { return }
        let destinationGrouping = groupBy
        await perform {
            let target = try await client.list(
                descriptor,
                pageSize: EntityBoardPlan.pageSize(spec, groupBy: destinationGrouping, key: destination.id),
                sort: EntityBoardPlan.sortParameter(spec, groupBy: destinationGrouping, key: destination.id),
                filters: destinationFilters)
            let body = EntityBoardPlan.drop(
                rows: target.items.map(\.raw), id: row.id,
                before: target.items.first?.id,
                group: [
                    destinationGrouping: destination.id == EntityListSection.noValueKey
                        ? .null : .string(destination.id)
                ], move: true)
            _ = try await client.executeCommand(operation: command.operation, body: body)
        }
    }

    private func reorder(_ index: Int, offset: Int) async {
        guard let command = spec.reorder, let current, rows.indices.contains(index + offset) else { return }
        let row = rows[index]
        let target =
            offset < 0 ? rows[index - 1].id : (rows.indices.contains(index + 2) ? rows[index + 2].id : nil)
        let body = EntityBoardPlan.drop(
            rows: rows.map(\.raw), id: row.id, before: target,
            group: [groupBy: current.id == EntityListSection.noValueKey ? .null : .string(current.id)])
        await perform { _ = try await client.executeCommand(operation: command.operation, body: body) }
    }

    private func perform(_ action: () async throws -> Void) async {
        guard !writing else { return }
        let captured = request
        writing = true
        defer { writing = false }
        do {
            try await action()
            guard !Task.isCancelled, request == captured else { return }
            await load()
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            Diagnostics.report(error, context: "Move entity board record")
            guard request == captured else { return }
            failure = error.userMessage
        }
    }
}
