import CubbyKit
import SwiftUI

private struct EntityListSearchModifier: ViewModifier {
    let enabled: Bool
    @Binding var text: String
    @Binding var isPresented: Bool
    let prompt: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            #if os(iOS)
                content.searchable(
                    text: $text, isPresented: $isPresented, placement: .navigationBarDrawer, prompt: prompt)
            #else
                content.searchable(text: $text, isPresented: $isPresented, prompt: prompt)
            #endif
        } else {
            content
        }
    }
}

/// The generic Browse list for one entity: the catalog's declared views (table, shelf, timeline),
/// its filters as a sheet, and `+` when the generated client can create the entity. A declared
/// slot view has no native fill, so the picker offers only the views this file renders.
struct EntityListView: View {
    private struct PresentationChoice: Identifiable {
        let id: String
        let label: String
        let symbol: String
        let view: ListView
        let density: ListPresentationChoice?
    }

    let key: EntityKey
    @Environment(AppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var model: GenericEntityListModel?
    @State private var showingFilters = false
    @State private var creating = false
    @State private var selecting = false
    @State private var selectedIDs: Set<String> = []
    @State private var searchText = ""
    @State private var searchPresented = false
    @State private var retainedSearchText = ""
    @State private var clearingSearchExplicitly = false
    @State private var confirmingDelete = false
    @State private var deleteError: String?
    @State private var cardDensity = ListPresentationChoice.cards
    private let initialFilters: EntityFilterState

    init(
        key: EntityKey, filters: EntityFilterState = EntityFilterState(),
        model: GenericEntityListModel? = nil
    ) {
        self.key = key
        self.initialFilters = filters
        // Reached via `.navigationDestination(for: Route.self)` (`Route.entityList`, a fresh
        // path entry per distinct `key`/`filters`) or, on macOS, `.id(key)`-scoped in
        // `RootSplitView` — both guarantee a full remount, never a stale `model` reused in place.
        _model = State(initialValue: model)  // state-init-ok
    }

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    /// Table, shelf and timeline; qualified `.slot` views remain web-owned until a native list
    /// slot is registered. Filtering by the coverage registry keeps an entity-qualified id from
    /// being mistaken for a built-in view during initial selection or picker changes.
    private var renderableViews: [ListView] {
        descriptor.presentation.listViews.filter {
            guard case .slot(let id, _, _) = $0 else { return true }
            switch NativePresentationCoverage.listSlot(id) {
            case .implemented, .generic: return true
            case .ownedElsewhere, .unsupported: return false
            }
        }
    }

    private var canDelete: Bool { key.nativeActions.contains(.delete) }

    private var presentationChoices: [PresentationChoice] {
        let shared = renderableViews.filter { $0 == .table } + renderableViews.filter { $0 == .shelf }
        let specialist = renderableViews.filter { $0 != .table && $0 != .shelf }
        return (shared + specialist).flatMap { view -> [PresentationChoice] in
            switch view {
            case .table:
                [
                    PresentationChoice(
                        id: ListPresentationChoice.list.rawValue,
                        label: ListPresentationChoice.list.label,
                        symbol: ListPresentationChoice.list.symbol, view: view,
                        density: nil)
                ]
            case .shelf:
                [ListPresentationChoice.cards, .compact].map { density in
                    PresentationChoice(
                        id: density.rawValue, label: density.label, symbol: density.symbol,
                        view: view, density: density)
                }
            case .timeline:
                [
                    PresentationChoice(
                        id: view.id, label: view.label, symbol: "calendar.day.timeline.left",
                        view: view, density: nil)
                ]
            case .slot:
                [
                    PresentationChoice(
                        id: view.id, label: view.label, symbol: "rectangle.dashed", view: view,
                        density: nil)
                ]
            }
        }
    }

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
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .accessibilityIdentifier("browse.\(key.rawValue).list")
        .modifier(
            EntityListSearchModifier(
                enabled: descriptor.primarySearch != nil,
                text: $searchText,
                isPresented: $searchPresented,
                prompt: descriptor.primarySearch?.placeholder
                    ?? "Search \(descriptor.plural.lowercased()) or shortcode"
            )
        )
        .onChange(of: searchText) { _, value in applySearchText(value) }
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
            if let model { await refreshVisible(model) }
        }
        .refreshControl { [model] in
            if let model { await refreshVisible(model) }
        }
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
                Task {
                    if let model { await refreshVisible(model) }
                }
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
        #if os(iOS)
            if key.nativeActions.contains(.create) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        creating = true
                    } label: {
                        Label("New \(descriptor.singular)", systemImage: "plus")
                    }
                    .accessibilityIdentifier("browse.\(key.rawValue).create")
                }
            }
            if hasControls {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        controlsMenu
                    } label: {
                        Label("Controls", systemImage: "slider.horizontal.3")
                    }
                    .accessibilityLabel("List controls")
                }
            }
        #else
            if let model, presentationChoices.count > 1 {
                ToolbarItem(placement: .primaryAction) {
                    presentationPicker(model)
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
        #endif
    }

    private var hasControls: Bool {
        (model != nil && presentationChoices.count > 1) || !descriptor.filters.isEmpty
            || (canDelete && model?.view == .table) || descriptor.primarySearch != nil
    }

    @ViewBuilder
    private var controlsMenu: some View {
        if descriptor.primarySearch != nil {
            Button("Search", systemImage: "magnifyingglass") { searchPresented = true }
            if !searchText.isEmpty {
                Button("Clear search", systemImage: "xmark.circle") { clearSearch() }
            }
        }
        if let model, presentationChoices.count > 1 {
            Menu("View") {
                ForEach(presentationChoices) { choice in
                    Button {
                        selectPresentation(choice.id, model: model)
                    } label: {
                        Label(choice.label, systemImage: choice.symbol)
                    }
                }
            }
        }
        if !descriptor.filters.isEmpty {
            Button {
                showingFilters = true
            } label: {
                Label(filterAccessibilityLabel, systemImage: "line.3.horizontal.decrease.circle")
            }
            .accessibilityIdentifier("browse.\(key.rawValue).filter")
        }
        if canDelete, model?.view == .table {
            if selecting {
                Button("Delete selected", role: .destructive) { confirmingDelete = true }
                    .disabled(selectedIDs.isEmpty)
                Button("Done selecting") {
                    selecting = false
                    selectedIDs = []
                }
            } else {
                Button("Select") { selecting = true }
            }
        }
    }

    private func clearSearch() {
        clearingSearchExplicitly = true
        searchText = ""
    }

    /// Search cancellation can write an empty string after the field has already stopped being
    /// presented. Preserve that query; deliberate erasure while the field is presented and the
    /// explicit Controls command both clear it on every platform.
    private func applySearchText(_ value: String) {
        if value.isEmpty {
            if clearingSearchExplicitly || searchPresented {
                retainedSearchText = ""
                clearingSearchExplicitly = false
                model?.setSearchQuery("")
            } else if !retainedSearchText.isEmpty {
                searchText = retainedSearchText
            } else {
                model?.setSearchQuery("")
            }
        } else {
            retainedSearchText = value
            model?.setSearchQuery(value)
        }
    }

    private var filterAccessibilityLabel: String {
        let count = model?.filters.activeCount ?? 0
        return count == 0 ? "Filter" : "Filter, \(count) active"
    }

    private func refreshVisible(_ model: GenericEntityListModel) async {
        if model.isSearching {
            await model.searchModel?.refresh()
        } else {
            await model.refresh()
        }
    }

    @ViewBuilder
    private func presentationPicker(_ model: GenericEntityListModel) -> some View {
        let selection = Binding(
            get: {
                switch model.view {
                case .table: ListPresentationChoice.list.rawValue
                case .shelf: cardDensity.rawValue
                case .timeline, .slot: model.view.id
                }
            },
            set: { id in selectPresentation(id, model: model) })
        if prefersSegmentedPresentationPicker {
            Picker("View", selection: selection) {
                ForEach(presentationChoices) { choice in Text(choice.label).tag(choice.id) }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("View")
        } else {
            Picker("View", selection: selection) {
                ForEach(presentationChoices) { choice in
                    Label(choice.label, systemImage: choice.symbol).tag(choice.id)
                }
            }
            .pickerStyle(.menu)
            .accessibilityLabel("View")
        }
    }

    private var prefersSegmentedPresentationPicker: Bool {
        guard !dynamicTypeSize.isAccessibilitySize, presentationChoices.count <= 3 else {
            return false
        }
        #if os(macOS)
            return true
        #else
            return horizontalSizeClass == .regular
        #endif
    }

    private func selectPresentation(_ id: String, model: GenericEntityListModel) {
        guard let choice = presentationChoices.first(where: { $0.id == id }) else { return }
        if let density = choice.density { cardDensity = density }
        if choice.view != .table {
            selecting = false
            selectedIDs = []
        }
        Task { await model.select(view: choice.view) }
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
            cardGrid(model, rows: model.rows, meta: model.meta)
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
            } else if model.view == .shelf {
                cardGrid(model, rows: search.rows, meta: search.meta)
            } else {
                rowList(model)
            }
        } else {
            ContentUnavailableView("Search unavailable", systemImage: "magnifyingglass")
        }
    }

    private func cardGrid(
        _ model: GenericEntityListModel, rows: [EntityRow], meta: ListPageMeta?
    ) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if hasBanner(model) { banner(model).padding(.horizontal) }
                if let meta {
                    Text("\(meta.totalCount.formatted()) total · \(rows.count.formatted()) shown")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, PorcelainTokens.Space.md)
                        .padding(.top, PorcelainTokens.Space.sm)
                }
                EntityShelfView(
                    descriptor: descriptor, rows: rows, density: cardDensity,
                    section: .browse)
                loadMore(model).padding()
            }
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
        model.refreshError != nil || model.searchModel?.refreshError != nil || deleteError != nil
    }

    @ViewBuilder
    private func banner(_ model: GenericEntityListModel) -> some View {
        if let error = model.refreshError {
            HStack {
                Text(error).foregroundStyle(.secondary)
                Button("Retry refresh") { Task { await model.refresh() } }
            }
        }
        if let error = model.searchModel?.refreshError {
            HStack {
                Text(error).foregroundStyle(.secondary)
                Button("Retry search refresh") {
                    Task { await model.searchModel?.refresh() }
                }
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
                        Clipboard.copy(appModel.webURL(for: key, id: row.id).absoluteString)
                    }
                    Button("Copy shortcode", systemImage: "number") { Clipboard.copy(row.id) }
                    ShareLink(item: appModel.webURL(for: key, id: row.id))
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
        await refreshVisible(model)
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
            } else if let imageURL = presentation.imageURL {
                Thumb(url: imageURL, size: thumbnailSize, symbol: entitySymbol(for: key))
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
                        .lineLimit(2)
                }
                if photoMode {
                    Text(presentation.shortcode)
                        .font(.caption2.monospaced())
                        .foregroundStyle(PorcelainTokens.graphiteSecondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: PorcelainTokens.Space.sm)
        }
        .padding(.vertical, PorcelainTokens.Space.xs)
        .frame(minHeight: 56, alignment: .center)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            photoMode
                ? "\(presentation.accessibilityText), \(presentation.shortcode)"
                : presentation.accessibilityText)
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
