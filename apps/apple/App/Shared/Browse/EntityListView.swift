import CubbyKit
import SwiftUI

private struct EntityListSearchModifier: ViewModifier {
    let enabled: Bool
    @Binding var text: String
    let prompt: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.searchable(text: $text, prompt: prompt)
        } else {
            content
        }
    }
}

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
    @State private var searchText = ""
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
        .modifier(
            EntityListSearchModifier(
                enabled: descriptor.primarySearch != nil,
                text: $searchText,
                prompt: descriptor.primarySearch?.placeholder
                    ?? "Search \(descriptor.plural.lowercased()) or shortcode"
            )
        )
        .onChange(of: searchText) { _, value in model?.setSearchQuery(value) }
        .toolbar { toolbarContent }
        #if os(iOS)
            .environment(\.editMode, .constant(selecting ? .active : .inactive))
        #endif
        .task(id: key) {
            if model == nil {
                model = GenericEntityListModel(
                    descriptor: descriptor, client: appModel.client, filters: initialFilters,
                    view: renderableViews.first ?? .table,
                    searchLoader: searchLoader(for: initialFilters))
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

    /// Binds the initial relation/date scope to the generic search state. The list model rebuilds
    /// this loader when filters change; passing it here also makes the first query work before a
    /// filter-sheet round trip can occur.
    private func searchLoader(for filters: EntityFilterState) -> EntityListSearchModel.PageLoader? {
        guard descriptor.primarySearch != nil else { return nil }
        let client = appModel.client
        return { query, page in
            var scopedFilters = filters
            scopedFilters.set(.single(query), for: "searchQuery")
            return try await client.list(
                descriptor, page: page, pageSize: 50, sort: nil, filters: scopedFilters)
        }
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
        if model.isSearching {
            searchContent(model)
        } else if model.view == .timeline {
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
    private func searchContent(_ model: GenericEntityListModel) -> some View {
        if let search = model.searchModel {
            if search.rows.isEmpty {
                switch search.phase {
                case .idle, .debouncing, .loading:
                    LoadingIndicator.screen(label: "Searching \(descriptor.plural)")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Couldn't search \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") { search.retry() }
                    }
                case .loaded:
                    ContentUnavailableView("No matching \(descriptor.plural)", systemImage: "magnifyingglass")
                }
            } else {
                rowList(model)
            }
        } else {
            ContentUnavailableView("Search unavailable", systemImage: "magnifyingglass")
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
        let visibleRows = model.isSearching ? (model.searchModel?.rows ?? []) : model.rows
        let visibleMeta = model.isSearching ? model.searchModel?.meta : model.meta
        if let meta = visibleMeta {
            Text("\(meta.totalCount.formatted()) total · \(visibleRows.count.formatted()) shown")
                .font(.caption).foregroundStyle(.secondary)
        }
        ForEach(visibleRows) { row in
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
        if model.isSearching ? (model.searchModel?.hasMore ?? false) : model.hasMore { loadMore(model) }
    }

    @ViewBuilder
    private func loadMore(_ model: GenericEntityListModel) -> some View {
        let hasMore = model.isSearching ? (model.searchModel?.hasMore ?? false) : model.hasMore
        if hasMore {
            let nextPageError = model.isSearching ? model.searchModel?.nextPageError : model.nextPageError
            if let error = nextPageError { Text(error).foregroundStyle(.secondary) }
            Button {
                Task {
                    if model.isSearching {
                        await model.searchModel?.loadNextPage()
                    } else {
                        await model.loadNextPage()
                    }
                }
            } label: {
                if model.isSearching
                    ? model.searchModel?.phase == .loading : model.activity == .loadingNextPage
                {
                    LoadingIndicator(label: "Loading more \(descriptor.plural)")
                } else {
                    Text(nextPageError == nil ? "Load more" : "Retry loading more")
                }
            }
            .disabled(model.isSearching ? model.searchModel?.phase != .loaded : model.activity != .idle)
            .accessibilityIdentifier("browse.\(key.rawValue).loadMore")
            // Scrolling to the row loads the next page; the button stays for retry after an error
            // (a failed page never auto-retries) and for VoiceOver.
            .onScrollVisibilityChange(threshold: 0.5) { visible in
                let idle = model.isSearching ? model.searchModel?.phase == .loaded : model.activity == .idle
                let noError =
                    model.isSearching ? model.searchModel?.nextPageError == nil : model.nextPageError == nil
                guard visible, idle, noError else { return }
                Task {
                    if model.isSearching {
                        await model.searchModel?.loadNextPage()
                    } else {
                        await model.loadNextPage()
                    }
                }
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
    var columns: [String]? = nil
    var photoMode = false
    /// Preview-only image injection keeps the production row on the shared URL-backed Thumb
    /// while allowing previews to exercise the real image geometry and clipping.
    var previewImage: Image? = nil

    private var presentation: EntityRowPresentation {
        EntityRowPresentation.resolve(
            descriptor: EntityCatalog[key], row: row, columns: columns, photoMode: photoMode)
    }

    private var thumbnailSize: CGFloat {
        #if os(iOS)
            48
        #else
            44
        #endif
    }

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.md) {
            if let previewImage {
                previewImage
                    .resizable()
                    .scaledToFill()
                    .frame(width: thumbnailSize, height: thumbnailSize)
                    .clipShape(RoundedRectangle(cornerRadius: PorcelainTokens.radiusControl))
                    .accessibilityHidden(true)
            } else {
                Thumb(url: presentation.imageURL, size: thumbnailSize, symbol: entitySymbol(for: key))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(PorcelainTokens.graphite)
                    .lineLimit(2)
                if let factLine = presentation.factLine {
                    Text(factLine)
                        .font(.caption)
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
                Text(presentation.shortcode)
                    .font(.caption2.monospaced())
                    .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
        .frame(minHeight: 56, alignment: .center)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.accessibilityText)
    }
}

#Preview("Compact rows · image") {
    List {
        EntityRowView(
            key: .product,
            row: PreviewFixtures.sampleRows[0],
            previewImage: Image(decorative: PreviewFixtures.sampleProbeImage, scale: 1))
    }
    .listStyle(.plain)
    .porcelainScreen()
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

#Preview("Compact rows · accessibility") {
    NavigationStack {
        List {
            EntityRowView(
                key: .product,
                row: EntityRow(
                    id: "PRD-9999",
                    title: "A very long product title that should expand without clipping",
                    subtitle: nil,
                    imageURL: nil,
                    raw: [
                        "id": "PRD-9999",
                        "name": "A very long product title that should expand without clipping",
                        "manufacturer": "Sample Manufacturer", "updatedAt": "2026-09-12T10:00:00.000Z",
                    ]))
        }
        .listStyle(.plain)
        .porcelainScreen()
        .preferredColorScheme(.dark)
        .environment(\.dynamicTypeSize, .accessibility3)
    }
}
