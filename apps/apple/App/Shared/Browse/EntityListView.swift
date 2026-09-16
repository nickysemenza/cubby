import CubbyKit
import SwiftUI

/// The generic Browse list for one entity: the catalog's declared views (table, shelf, timeline),
/// its filters as a sheet, and `+` when the generated client can create the entity. A declared
/// slot view has no native fill, so the picker offers only the views this file renders.
struct EntityListView: View {
    let key: EntityKey
    @Environment(AppModel.self) private var appModel
    @State private var model: GenericEntityListModel?
    @State private var showingFilters = false
    @State private var creating = false
    @State private var selecting = false
    @State private var selectedIDs: Set<String> = []
    @State private var confirmingDelete = false
    @State private var deleteError: String?
    private let initialFilters: EntityFilterState

    init(
        key: EntityKey, filters: EntityFilterState = EntityFilterState(),
        model: GenericEntityListModel? = nil
    ) {
        self.key = key
        self.initialFilters = filters
        _model = State(initialValue: model)
    }

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    /// Table, shelf and timeline; a `.slot` view renders only where a registry provides it (none).
    private var renderableViews: [ListView] {
        descriptor.presentation.listViews.filter {
            if case .slot = $0 { return false }
            return true
        }
    }

    private var canDelete: Bool { key.nativeActions.contains(.delete) }

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
            }
        }
        .porcelainScreen()
        .navigationTitle(descriptor.plural)
        .accessibilityIdentifier("browse.\(key.rawValue).list")
        .toolbar { toolbarContent }
        #if os(iOS)
            .environment(\.editMode, .constant(selecting ? .active : .inactive))
        #endif
        .task(id: key) {
            if model == nil {
                model = GenericEntityListModel(
                    descriptor: descriptor, client: appModel.client, filters: initialFilters,
                    view: renderableViews.first ?? .table)
            }
            await model?.loadInitial()
        }
        .task(id: appModel.entityMutationRevision) {
            guard appModel.entityMutationRevision > 0,
                appModel.entityMutationKeys.contains(key),
                model?.phase == .loaded
            else { return }
            await model?.refresh()
        }
        .refreshControl { await model?.refresh() }
        .sheet(isPresented: $showingFilters) {
            if let model {
                EntityFilterSheet(descriptor: descriptor, filters: model.filters) { filters in
                    await model.apply(filters: filters)
                }
                .environment(appModel)
            }
        }
        .sheet(isPresented: $creating) {
            EntityEditorSheet(key: key, mode: .create(prefill: [:])) { _ in
                Task { await model?.refresh() }
            }
            .environment(appModel)
        }
        .confirmationDialog(
            "Delete \(selectedIDs.count) \(selectedIDs.count == 1 ? descriptor.singular : descriptor.plural)?",
            isPresented: $confirmingDelete, titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) { Task { await deleteSelected() } }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if let model, renderableViews.count > 1 {
            ToolbarItem(placement: .primaryAction) {
                Picker(
                    "View",
                    selection: Binding(
                        get: { model.view.id },
                        set: { id in
                            guard let view = renderableViews.first(where: { $0.id == id }) else {
                                return
                            }
                            Task { await model.select(view: view) }
                        })
                ) {
                    ForEach(renderableViews) { view in
                        Label(view.label, systemImage: Self.symbol(for: view)).tag(view.id)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityLabel("View")
            }
        }
        if !descriptor.filters.isEmpty {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showingFilters = true
                } label: {
                    Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
                }
                .badge(model?.filters.activeCount ?? 0)
                .accessibilityLabel(filterAccessibilityLabel)
                .accessibilityIdentifier("browse.\(key.rawValue).filter")
            }
        }
        if key.nativeActions.contains(.create) {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    creating = true
                } label: {
                    Label("New \(descriptor.singular)", systemImage: "plus")
                }
                .accessibilityIdentifier("browse.\(key.rawValue).create")
            }
        }
        if canDelete, model?.view == .table {
            ToolbarItem(placement: .secondaryAction) {
                if selecting {
                    Button("Delete selected", role: .destructive) { confirmingDelete = true }
                        .disabled(selectedIDs.isEmpty)
                    Button("Done") {
                        selecting = false
                        selectedIDs = []
                    }
                } else {
                    Button("Select") { selecting = true }
                }
            }
        }
    }

    private var filterAccessibilityLabel: String {
        let count = model?.filters.activeCount ?? 0
        return count == 0 ? "Filter" : "Filter, \(count) active"
    }

    private static func symbol(for view: ListView) -> String {
        switch view {
        case .table: "list.bullet"
        case .shelf: "square.grid.2x2"
        case .timeline: "calendar.day.timeline.left"
        case .slot: "rectangle.dashed"
        }
    }

    @ViewBuilder
    private func content(_ model: GenericEntityListModel) -> some View {
        if model.view == .timeline {
            timeline(model)
        } else if model.rows.isEmpty {
            switch model.phase {
            case .idle, .loading:
                LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
            case .unavailable(let message):
                ContentUnavailableView(message, systemImage: entitySymbol(for: key))
            case .failed(let message):
                ContentUnavailableView {
                    Label("Couldn't load \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Retry") { Task { await model.loadInitial() } }
                }
            case .loaded:
                ContentUnavailableView {
                    Label(
                        model.filters.isEmpty
                            ? "No \(descriptor.plural) yet" : "No matching \(descriptor.plural)",
                        systemImage: entitySymbol(for: key))
                } actions: {
                    if !model.filters.isEmpty {
                        Button("Clear filters") { Task { await model.apply(filters: EntityFilterState()) } }
                    }
                }
            }
        } else if model.view == .shelf {
            ScrollView {
                if hasBanner(model) { banner(model).padding(.horizontal) }
                EntityShelfView(descriptor: descriptor, rows: model.rows)
                loadMore(model).padding()
            }
        } else {
            rowList(model)
        }
    }

    @ViewBuilder
    private func timeline(_ model: GenericEntityListModel) -> some View {
        List {
            if let error = model.timelineError {
                Section {
                    Text(error).foregroundStyle(.secondary)
                    Button("Retry") { Task { await model.loadTimeline() } }
                }
            } else if let timeline = model.timeline {
                EntityTimelineView(timeline: timeline)
            } else {
                LoadingIndicator(label: "Loading timeline")
            }
        }
        .listStyle(.plain)
    }

    private func hasBanner(_ model: GenericEntityListModel) -> Bool {
        model.refreshError != nil || deleteError != nil
    }

    @ViewBuilder
    private func banner(_ model: GenericEntityListModel) -> some View {
        if let error = model.refreshError {
            HStack {
                Text(error).foregroundStyle(.secondary)
                Button("Retry refresh") { Task { await model.refresh() } }
            }
        }
        if let deleteError {
            Text(deleteError).foregroundStyle(PorcelainTokens.destructive)
        }
    }

    private var selection: Binding<RecordSelection?>? {
        #if os(macOS)
            Binding(
                get: { appModel.navigator.selectedRecords[.browse] },
                set: { appModel.navigator.selectRecord($0, in: .browse) })
        #else
            nil
        #endif
    }

    @ViewBuilder
    private func rowList(_ model: GenericEntityListModel) -> some View {
        if selecting {
            List(selection: $selectedIDs) { rows(model) }.listStyle(.plain)
        } else {
            List(selection: selection) { rows(model) }.listStyle(.plain)
        }
    }

    @ViewBuilder
    private func rows(_ model: GenericEntityListModel) -> some View {
        if hasBanner(model) { Section { banner(model) } }
        if let meta = model.meta {
            Text("\(meta.totalCount.formatted()) total · \(model.rows.count.formatted()) shown")
                .font(.caption).foregroundStyle(.secondary)
        }
        ForEach(model.rows) { row in
            rowContent(row)
                .contextMenu {
                    Button("Copy link", systemImage: "link") {
                        Clipboard.copy(appModel.webURL(for: row.id).absoluteString)
                    }
                    Button("Copy shortcode", systemImage: "number") { Clipboard.copy(row.id) }
                    ShareLink(item: appModel.webURL(for: row.id))
                }
                .accessibilityIdentifier("browse.\(key.rawValue).row.\(row.id)")
        }
        if model.hasMore { loadMore(model) }
    }

    @ViewBuilder
    private func loadMore(_ model: GenericEntityListModel) -> some View {
        if model.hasMore {
            if let error = model.nextPageError { Text(error).foregroundStyle(.secondary) }
            Button {
                Task { await model.loadNextPage() }
            } label: {
                if model.activity == .loadingNextPage {
                    LoadingIndicator(label: "Loading more \(descriptor.plural)")
                } else {
                    Text(model.nextPageError == nil ? "Load more" : "Retry loading more")
                }
            }
            .disabled(model.activity != .idle)
            .accessibilityIdentifier("browse.\(key.rawValue).loadMore")
            // Scrolling to the row loads the next page; the button stays for retry after an error
            // (a failed page never auto-retries) and for VoiceOver.
            .onScrollVisibilityChange(threshold: 0.5) { visible in
                guard visible, model.activity == .idle, model.nextPageError == nil else { return }
                Task { await model.loadNextPage() }
            }
        }
    }

    @ViewBuilder private func rowContent(_ row: EntityRow) -> some View {
        if selecting {
            EntityRowView(key: key, row: row).tag(row.id)
        } else {
            #if os(macOS)
                if appModel.navigator.section == .browse && appModel.navigator.browseKey == key {
                    EntityRowView(key: key, row: row).tag(RecordSelection(key: key, id: row.id))
                } else {
                    NavigationLink(value: Route.entityDetail(key, id: row.id)) {
                        EntityRowView(key: key, row: row)
                    }
                }
            #else
                NavigationLink(value: Route.entityDetail(key, id: row.id)) {
                    EntityRowView(key: key, row: row)
                }
            #endif
        }
    }

    private func deleteSelected() async {
        guard let model else { return }
        deleteError = nil
        var failed: [String] = []
        for id in selectedIDs {
            do {
                try await appModel.client.delete(descriptor, id: id)
            } catch {
                failed.append(id)
                Diagnostics.report(error, context: "browse.delete")
            }
        }
        if !failed.isEmpty { deleteError = "Couldn't delete \(failed.joined(separator: ", "))" }
        selectedIDs = []
        selecting = false
        appModel.recordEntityMutation(keys: [key])
        await model.refresh()
    }
}

/// Plain-data row rendering, shared by the real list and `#Preview`s so neither needs a network
/// round trip to render. The trailing fact is the catalog's mobile `trailing` column, read
/// straight off `raw` — never an extra request.
struct EntityRowView: View {
    let key: EntityKey
    let row: EntityRow

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            Thumb(url: row.imageURL, size: 56, symbol: entitySymbol(for: key))
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                if let subtitle = row.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.porcelainBody)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
            if let fact = EntityFieldValue.trailing(descriptor: EntityCatalog[key], raw: row.raw) {
                Text(fact)
                    .font(.porcelainData)
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .multilineTextAlignment(.trailing)
                    .lineLimit(2)
                    .layoutPriority(1)
            }
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
        .frame(minHeight: 64)
    }
}

#Preview("Rows") {
    NavigationStack {
        List {
            ForEach(PreviewFixtures.sampleRows) { row in
                NavigationLink(value: Route.entityDetail(.product, id: row.id)) {
                    EntityRowView(key: .product, row: row)
                }
                .porcelainListRow()
            }
        }
        .listStyle(.plain)
        .porcelainScreen()
        .navigationTitle("Products")
    }
}
