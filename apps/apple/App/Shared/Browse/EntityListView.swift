import CubbyKit
import Foundation
import SwiftUI

private struct EntityRowFieldComparator: SortComparator {
    let fieldKey: String
    var order: SortOrder = .forward

    func compare(_ lhs: EntityRow, _ rhs: EntityRow) -> ComparisonResult {
        // Table emits header descriptors; the server orders the complete paginated result.
        .orderedSame
    }
}

enum BrowsePresentation: String {
    case list
    case table
}

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
        let browsePresentation: BrowsePresentation?
    }

    let key: EntityKey
    @Environment(AppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var model: GenericEntityListModel?
    @State private var showingFilters = false
    @State private var creating = false
    @State private var searchText = ""
    @State private var searchPresented = false
    @State private var retainedSearchText = ""
    @State private var clearingSearchExplicitly = false
    @State private var cardDensity = ListPresentationChoice.cards
    @State private var browsePresentation = BrowsePresentation.list
    @State private var hiddenTableColumns = Set<String>()
    private let initialFilters: EntityFilterState
    private let usesBrowseSelection: Bool

    init(
        key: EntityKey, filters: EntityFilterState = EntityFilterState(),
        model: GenericEntityListModel? = nil,
        presentation: BrowsePresentation = .list,
        usesBrowseSelection: Bool = false
    ) {
        self.key = key
        self.initialFilters = filters
        self.usesBrowseSelection = usesBrowseSelection
        // Reached via `.navigationDestination(for: Route.self)` (`Route.entityList`, a fresh
        // path entry per distinct `key`/`filters`) or, on macOS, `.id(key)`-scoped in
        // `RootSplitView` — both guarantee a full remount, never a stale `model` reused in place.
        _model = State(initialValue: model)  // state-init-ok
        _browsePresentation = State(initialValue: presentation)  // state-init-ok: route-scoped lifetime
        _hiddenTableColumns = State(  // state-init-ok: manifest defaults for this route's entity
            initialValue: Set(EntityCatalog[key].fields.filter(\.listHidden).map(\.key)))
    }

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    /// Filtering by the coverage registry keeps an entity-qualified slot from being mistaken
    /// for a built-in view during initial selection or picker changes.
    private var renderableViews: [ListView] {
        NativePresentationCoverage.listViews(for: descriptor)
    }

    private var presentationChoices: [PresentationChoice] {
        let shared = renderableViews.filter { $0 == .shelf }
        let specialist = renderableViews.filter { $0 != .table && $0 != .shelf }
        let browse = [BrowsePresentation.list, .table].map { presentation in
            PresentationChoice(
                id: presentation.rawValue,
                label: presentation == .list ? "List" : "Table",
                symbol: presentation == .list ? "list.bullet" : "tablecells",
                view: .table, density: nil, browsePresentation: presentation)
        }
        return browse
            + (shared + specialist).flatMap { view -> [PresentationChoice] in
                switch view {
                case .table: []
                case .shelf:
                    [ListPresentationChoice.cards, .compact].map { density in
                        PresentationChoice(
                            id: density.rawValue, label: density.label, symbol: density.symbol,
                            view: view, density: density, browsePresentation: nil)
                    }
                case .timeline:
                    [
                        PresentationChoice(
                            id: view.id, label: view.label, symbol: "calendar.day.timeline.left",
                            view: view, density: nil, browsePresentation: nil)
                    ]
                case .slot:
                    [
                        PresentationChoice(
                            id: view.id, label: view.label, symbol: "rectangle.dashed", view: view,
                            density: nil, browsePresentation: nil)
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
        .fieldGuideScreen()
        .navigationTitle(descriptor.plural)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .accessibilityElement(children: .contain)
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
        .onChange(
            of: model.map {
                visibleEnrichment($0).errors + [visibleEnrichment($0).summaryError].compactMap { $0 }
            } ?? []
        ) { previous, errors in
            for message in errors where !previous.contains(message) {
                Diagnostics.report(
                    NSError(
                        domain: "EntityListEnrichment", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: message]),
                    context: "Browse \(key.rawValue)")
            }
        }
        .toolbar { toolbarContent }
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
        #endif
    }

    private var hasControls: Bool {
        (model != nil && presentationChoices.count > 1) || !descriptor.filters.isEmpty
            || descriptor.primarySearch != nil
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
                    .accessibilityIdentifier("browse.\(key.rawValue).view.\(choice.id)")
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
    private func specialistSlot(_ id: String, model: GenericEntityListModel) -> some View {
        let filters = specialistFilters(model)
        if let slot = EntityListSlotID(rawValue: id), let build = ListSlotRegistry.builders[slot] {
            build(appModel.client, filters)
        } else {
            ContentUnavailableView("View unavailable", systemImage: "square.dashed")
        }
    }

    private func specialistFilters(_ model: GenericEntityListModel) -> EntityFilterState {
        var filters = model.filters
        if let query = model.searchModel?.query, !query.isEmpty {
            filters.set(.single(query), for: "search")
        }
        return filters
    }

    @ViewBuilder
    private func presentationPicker(_ model: GenericEntityListModel) -> some View {
        let selection = Binding(
            get: {
                switch model.view {
                case .table: browsePresentation.rawValue
                case .shelf: cardDensity.rawValue
                case .timeline, .slot: model.view.id
                }
            },
            set: { id in selectPresentation(id, model: model) })
        ViewThatFits(in: .horizontal) {
            if !dynamicTypeSize.isAccessibilitySize && presentationChoices.count <= 3 {
                Picker("View", selection: selection) {
                    ForEach(presentationChoices) { choice in
                        Text(choice.label)
                            .tag(choice.id)
                            .accessibilityIdentifier("browse.\(key.rawValue).view.\(choice.id)")
                    }
                }
                .pickerStyle(.segmented)
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityLabel("View")
            }
            Picker("View", selection: selection) {
                ForEach(presentationChoices) { choice in
                    Label(choice.label, systemImage: choice.symbol)
                        .tag(choice.id)
                        .accessibilityIdentifier("browse.\(key.rawValue).view.\(choice.id)")
                }
            }
            .pickerStyle(.menu)
            .accessibilityLabel("View")
        }
    }

    private func selectPresentation(_ id: String, model: GenericEntityListModel) {
        guard let choice = presentationChoices.first(where: { $0.id == id }) else { return }
        if let density = choice.density { cardDensity = density }
        if let browsePresentation = choice.browsePresentation {
            self.browsePresentation = browsePresentation
        }
        Task { await model.select(view: choice.view) }
    }

    @ViewBuilder
    private func content(_ model: GenericEntityListModel) -> some View {
        if case .slot(let id, _, _) = model.view {
            specialistSlot(id, model: model)
        } else if model.isSearching {
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
                LoadFailureView(title: "Couldn't load \(descriptor.plural)", message: message) {
                    await model.loadInitial()
                }
            case .loaded:
                VStack {
                    if hasBanner(model) { banner(model) }
                    if let meta = model.summaryMeta { listSummary(meta: meta, shown: 0) }
                    ContentUnavailableView {
                        Label(
                            model.filters.isEmpty
                                ? "No \(descriptor.plural) yet" : "No matching \(descriptor.plural)",
                            systemImage: entitySymbol(for: key))
                    } actions: {
                        if !model.filters.isEmpty {
                            Button("Clear filters") {
                                Task { await model.apply(filters: EntityFilterState()) }
                            }
                        }
                    }
                }
            }
        } else if model.view == .shelf {
            cardGrid(model, rows: model.rows, meta: model.summaryMeta)
        } else if model.view == .table && browsePresentation == .table {
            tableView(model)
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
                    LoadFailureView(title: "Couldn't search \(descriptor.plural)", message: message) {
                        search.retry()
                    }
                case .loaded:
                    VStack {
                        if hasBanner(model) { banner(model) }
                        if let meta = search.summaryMeta { listSummary(meta: meta, shown: 0) }
                        ContentUnavailableView(
                            "No matching \(descriptor.plural)", systemImage: "magnifyingglass")
                    }
                }
            } else if model.view == .shelf {
                cardGrid(model, rows: search.rows, meta: search.summaryMeta)
            } else if model.view == .table && browsePresentation == .table {
                tableView(model)
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
                    listSummary(meta: meta, shown: rows.count)
                        .padding(.horizontal, FieldGuideTokens.Space.md)
                        .padding(.top, FieldGuideTokens.Space.sm)
                }
                EntityShelfView(
                    descriptor: descriptor, rows: rows, density: cardDensity,
                    section: .browse)
                loadMore(model).padding(FieldGuideTokens.Space.md)
            }
        }
    }

    @ViewBuilder
    private func timeline(_ model: GenericEntityListModel) -> some View {
        List {
            if let error = model.timelineError {
                Section {
                    InlineLoadFailure(message: error) { await model.loadTimeline() }
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
        model.refreshError != nil || model.searchModel?.refreshError != nil
            || !visibleEnrichment(model).errors.isEmpty
            || visibleEnrichment(model).summaryError != nil
            || (!descriptor.presentation.listTotals.isEmpty && visibleEnrichment(model).isLoadingSummary)
    }

    private func visibleEnrichment(_ model: GenericEntityListModel) -> EntityListEnrichmentModel {
        model.isSearching ? (model.searchModel?.enrichment ?? model.enrichment) : model.enrichment
    }

    @ViewBuilder
    private func banner(_ model: GenericEntityListModel) -> some View {
        let enrichment = visibleEnrichment(model)
        let detailErrors = enrichment.errors + [enrichment.summaryError].compactMap { $0 }
        if !detailErrors.isEmpty {
            InlineLoadFailure(message: detailErrors.joined(separator: "\n")) { enrichment.retry() }
        }
        if enrichment.isLoadingSummary && !descriptor.presentation.listTotals.isEmpty {
            LoadingIndicator(label: "Loading totals")
        }
        if let error = model.refreshError {
            InlineLoadFailure(message: error) { await model.refresh() }
        }
        if let search = model.searchModel, let error = search.refreshError {
            InlineLoadFailure(message: error) { await search.refresh() }
        }
    }

    private var selection: Binding<RecordSelection?>? {
        #if os(macOS)
            usesBrowseSelection
                ? Binding(
                    get: { appModel.navigator.selectedRecords[.browse] },
                    set: { appModel.navigator.selectRecord($0, in: .browse) }) : nil
        #else
            nil
        #endif
    }

    #if os(macOS)
        private var tableSelection: Binding<String?> {
            Binding(
                get: { usesBrowseSelection ? appModel.navigator.selectedRecords[.browse]?.id : nil },
                set: { id in
                    if usesBrowseSelection {
                        appModel.navigator.selectRecord(
                            id.map { RecordSelection(key: key, id: $0) }, in: .browse)
                    } else if let id {
                        appModel.navigator.paths[appModel.navigator.section, default: []]
                            .append(.entityDetail(key, id: id))
                    }
                })
        }

        private func tableSortOrder(_ model: GenericEntityListModel) -> Binding<[EntityRowFieldComparator]> {
            Binding(
                get: {
                    guard let sort = model.sort else { return [] }
                    let descending = sort.hasPrefix("-")
                    return [
                        EntityRowFieldComparator(
                            fieldKey: descending ? String(sort.dropFirst()) : sort,
                            order: descending ? .reverse : .forward)
                    ]
                },
                set: { order in
                    guard let comparator = order.first,
                        descriptor.sortFields.contains(comparator.fieldKey)
                    else { return }
                    let sort = comparator.order == .forward ? comparator.fieldKey : "-\(comparator.fieldKey)"
                    Task { await model.apply(sort: sort) }
                })
        }
    #endif

    @ViewBuilder
    private func rowList(_ model: GenericEntityListModel) -> some View {
        List(selection: selection) { rows(model) }.listStyle(.plain)
    }

    private var tableFields: [FieldDescriptor] {
        allTableFields.filter { !hiddenTableColumns.contains($0.key) }
    }

    private var allTableFields: [FieldDescriptor] {
        descriptor.fields
            .filter {
                $0.showInList && $0.key != "id" && $0.key != descriptor.titleField
                    && ($0.kind != .json || $0.listRenderer != nil || $0.labelPath != nil
                        || $0.format != nil || $0.reference != nil)
            }
            .sorted {
                let left = ($0.listOrder ?? .max, $0.key)
                let right = ($1.listOrder ?? .max, $1.key)
                return left < right
            }
    }

    private func sortKey(for field: FieldDescriptor) -> String? {
        let key = field.columnId ?? field.key
        return descriptor.sortFields.contains(key) ? key : nil
    }

    private func sortHeading(_ title: String, key: String?, model: GenericEntityListModel) -> some View {
        Button {
            guard let key else { return }
            let current = model.sort
            let nextSort = current == key ? "-\(key)" : key
            Task { await model.apply(sort: nextSort) }
        } label: {
            HStack(spacing: 4) {
                Text(title)
                if let key, model.sort == key || model.sort == "-\(key)" {
                    Image(systemName: model.sort == key ? "arrow.up" : "arrow.down")
                        .font(.caption2)
                }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(minWidth: FieldGuideTokens.touchTarget, minHeight: FieldGuideTokens.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(key == nil)
        .accessibilityLabel(key == nil ? title : "Sort by \(title)")
        .accessibilityValue(
            key.map { model.sort == $0 ? "Ascending" : model.sort == "-\($0)" ? "Descending" : "Not sorted" }
                ?? ""
        )
        .accessibilityIdentifier(key.map { "browse.\(self.key.rawValue).sort.\($0)" } ?? "")
    }

    private func tableControls(_ model: GenericEntityListModel) -> some View {
        HStack {
            if hasBanner(model) { banner(model) }
            Spacer()
            Menu("Columns", systemImage: "tablecells") {
                ForEach(allTableFields, id: \.key) { field in
                    Toggle(
                        field.label,
                        isOn: Binding(
                            get: { !hiddenTableColumns.contains(field.key) },
                            set: { visible in
                                if visible {
                                    hiddenTableColumns.remove(field.key)
                                } else {
                                    hiddenTableColumns.insert(field.key)
                                }
                            })
                    )
                    .accessibilityIdentifier("browse.\(key.rawValue).column.\(field.key)")
                }
            }
            .accessibilityLabel("Show or hide table columns")
            .accessibilityIdentifier("browse.\(key.rawValue).columns")
        }
        .padding(.horizontal, FieldGuideTokens.Space.md)
        .padding(.vertical, FieldGuideTokens.Space.xs)
    }

    private var tableTitleLabel: String {
        descriptor.fields.first(where: { $0.key == descriptor.titleField })?.label ?? descriptor.singular
    }

    private func tableTitle(_ row: EntityRow) -> some View {
        Text(row.title)
            .font(.body.weight(.semibold))
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            .accessibilityIdentifier("browse.\(key.rawValue).table.row.\(row.id)")
    }

    @ViewBuilder
    private func tableView(_ model: GenericEntityListModel) -> some View {
        let visibleRows = model.isSearching ? (model.searchModel?.rows ?? []) : model.rows
        let visibleMeta = model.isSearching ? model.searchModel?.summaryMeta : model.summaryMeta
        #if os(macOS)
            // Native table cells are rehosted when sorting replaces the rows. Capture the
            // owning model before that boundary so explanation views keep their dependency.
            let cellAppModel = appModel
        #endif
        VStack(spacing: 0) {
            tableControls(model)
            #if os(macOS)
                Table(visibleRows, selection: tableSelection, sortOrder: tableSortOrder(model)) {
                    if descriptor.sortFields.contains(descriptor.titleField) {
                        TableColumn(
                            Text(tableTitleLabel),
                            sortUsing: EntityRowFieldComparator(fieldKey: descriptor.titleField)
                        ) { row in
                            tableTitle(row)
                        }
                        .width(min: 240)
                        .customizationID("title")
                    }
                    if !descriptor.sortFields.contains(descriptor.titleField) {
                        TableColumn(Text(tableTitleLabel)) { (row: EntityRow) in
                            tableTitle(row)
                        }
                        .width(min: 240)
                        .customizationID("title")
                    }
                    TableColumnForEach(tableFields, id: \.key) { field in
                        if let sortKey = sortKey(for: field) {
                            TableColumn(
                                Text(field.label), sortUsing: EntityRowFieldComparator(fieldKey: sortKey)
                            ) { row in
                                tableCell(field, row: row)
                                    .environment(cellAppModel)
                            }
                            .width(min: 180)
                            .customizationID(field.key)
                        }
                        if sortKey(for: field) == nil {
                            TableColumn(Text(field.label)) { (row: EntityRow) in
                                tableCell(field, row: row)
                                    .environment(cellAppModel)
                            }
                            .width(min: 180)
                            .customizationID(field.key)
                        }
                    }
                }
                .contextMenu(forSelectionType: String.self) { records in
                    if let id = records.first {
                        Button("Copy link", systemImage: "link") {
                            Clipboard.copy(appModel.webURL(for: key, id: id).absoluteString)
                        }
                        Button("Copy shortcode", systemImage: "number") { Clipboard.copy(id) }
                        ShareLink(item: appModel.webURL(for: key, id: id))
                    }
                }
                .accessibilityIdentifier("browse.\(key.rawValue).table")
            #else
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 0) {
                            sortHeading(
                                tableTitleLabel,
                                key: descriptor.sortFields.contains(descriptor.titleField)
                                    ? descriptor.titleField : nil, model: model
                            )
                            .frame(width: 240, alignment: .leading)
                            ForEach(tableFields, id: \.key) { field in
                                sortHeading(field.label, key: sortKey(for: field), model: model)
                                    .frame(width: 180, alignment: .leading)
                            }
                        }
                        .padding(.horizontal, FieldGuideTokens.Space.md)
                        .padding(.vertical, FieldGuideTokens.Space.sm)
                        .background(.quaternary.opacity(0.5))
                        ForEach(visibleRows) { row in
                            HStack(spacing: 0) {
                                NavigationLink(value: Route.entityDetail(key, id: row.id)) {
                                    Text(row.title)
                                        .font(.body.weight(.medium))
                                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                        .frame(width: 240, alignment: .leading)
                                        .frame(minHeight: FieldGuideTokens.touchTarget)
                                        .contentShape(Rectangle())
                                        .accessibilityIdentifier(
                                            "browse.\(key.rawValue).table.row.\(row.id)")
                                }
                                .buttonStyle(.plain)
                                ForEach(tableFields, id: \.key) { field in
                                    tableCell(field, row: row)
                                        .frame(width: 180, alignment: .leading)
                                }
                            }
                            .padding(.horizontal, FieldGuideTokens.Space.md)
                            .frame(minHeight: 48)
                            .contentShape(Rectangle())
                            .contextMenu {
                                Button("Copy link", systemImage: "link") {
                                    Clipboard.copy(appModel.webURL(for: key, id: row.id).absoluteString)
                                }
                                Button("Copy shortcode", systemImage: "number") { Clipboard.copy(row.id) }
                                ShareLink(item: appModel.webURL(for: key, id: row.id))
                            }
                            Divider()
                        }
                    }
                }
                .accessibilityIdentifier("browse.\(key.rawValue).table")
            #endif
            if let visibleMeta {
                listSummary(meta: visibleMeta, shown: visibleRows.count)
                    .padding(.horizontal, FieldGuideTokens.Space.md)
                    .padding(.vertical, FieldGuideTokens.Space.xs)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("browse.\(key.rawValue).table.summary")
            }
            if model.isSearching ? (model.searchModel?.hasMore ?? false) : model.hasMore {
                loadMore(model)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, FieldGuideTokens.Space.sm)
            }
        }
    }

    @ViewBuilder
    private func tableReference(_ reference: EntityFieldValue.Reference, value: String) -> some View {
        let label = Text(value)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            .frame(
                minWidth: FieldGuideTokens.touchTarget,
                minHeight: FieldGuideTokens.touchTarget, alignment: .leading
            )
            .contentShape(Rectangle())
        if usesBrowseSelection {
            Button {
                appModel.navigator.openRecord(.init(key: reference.entity, id: reference.id))
            } label: {
                label
            }
        } else {
            NavigationLink(value: Route.entityDetail(reference.entity, id: reference.id)) {
                label
            }
        }
    }

    @ViewBuilder
    private func tableCell(_ field: FieldDescriptor, row: EntityRow) -> some View {
        let fact = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: [field.key]
        ).facts.first(where: { $0.id == field.key })
        if let fact {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                if let reference = EntityFieldValue.reference(in: row.raw, field: field, surface: "list") {
                    tableReference(reference, value: fact.value)
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier(
                            "browse.\(key.rawValue).table.reference.\(row.id).\(field.key)")
                } else if let color = FieldGuideMetrics.optionColor(
                    EntityFieldValue.optionColor(in: row.raw, field: field, surface: "list"))
                {
                    StatusChip(text: fact.value, color: color)
                } else {
                    Text(fact.value)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                }
                if let source = fact.source {
                    Text(source).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if field.explanation != nil {
                    FieldExplanationLabel(
                        field: field, subject: EntityRef(entity: key, id: row.id),
                        labelOverride: "About \(field.label)", surface: "list")
                }
            }
        } else if row.pendingFields.contains(field.key) {
            Text("Loading…").foregroundStyle(.secondary).lineLimit(1)
        } else if row.failedFields.contains(field.key) {
            Text("Unavailable").foregroundStyle(.secondary).lineLimit(1)
        } else {
            Text("—").foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func rows(_ model: GenericEntityListModel) -> some View {
        if hasBanner(model) { Section { banner(model) } }
        let visibleRows = model.isSearching ? (model.searchModel?.rows ?? []) : model.rows
        let visibleMeta = model.isSearching ? model.searchModel?.summaryMeta : model.summaryMeta
        if let meta = visibleMeta {
            listSummary(meta: meta, shown: visibleRows.count)
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

    private func listSummary(meta: ListPageMeta, shown: Int) -> some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
            Text("\(meta.totalCount.formatted()) total · \(shown.formatted()) shown")
            if let totals = ListTotalsSummary.line(
                totals: descriptor.presentation.listTotals,
                sums: meta.sums?.additionalProperties)
            {
                Text(totals)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
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
        #if os(macOS)
            if usesBrowseSelection {
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

/// Plain-data row rendering, shared by the real list and `#Preview`s so neither needs a network
/// round trip to render. The trailing fact is the catalog's mobile `trailing` column, read
/// straight off `raw` — never an extra request.
/// Specialist rows use the same manifest renderer and lazy explanation as ordinary entity rows.
struct EntityQualityFact: View {
    let key: EntityKey
    let id: String
    let raw: JSONValue

    var body: some View {
        let descriptor = EntityCatalog[key]
        let row = EntityRow(id: id, title: "", subtitle: nil, imageURL: nil, raw: raw)
        let quality = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: ["dataQuality"]
        ).facts.first
        if let quality, let field = descriptor.field("dataQuality") {
            FieldExplanationLabel(
                field: field, subject: EntityRef(entity: key, id: id), labelOverride: quality.value,
                surface: "list"
            )
            .font(.caption.weight(.medium))
        }
    }
}

struct EntityRowView: View {
    let key: EntityKey
    let row: EntityRow
    var columns: [String]? = nil
    var photoMode = false
    /// Preview-only image injection keeps the production row on the shared URL-backed Thumb
    /// while allowing previews to exercise the real image geometry and clipping.
    var previewImage: Image? = nil
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var presentation: EntityRowPresentation {
        EntityRowPresentation.resolve(
            descriptor: EntityCatalog[key], row: row, columns: columns, photoMode: photoMode)
    }

    private var thumbnailSize: CGFloat {
        #if os(iOS)
            36
        #else
            36
        #endif
    }

    @ViewBuilder
    private func factView(_ fact: EntityRowPresentation.Fact) -> some View {
        let field = EntityCatalog[key].field(fact.id)
        HStack(spacing: FieldGuideTokens.Space.xs) {
            if fact.id == "dataQuality", let field {
                FieldExplanationLabel(
                    field: field, subject: EntityRef(entity: key, id: row.id),
                    labelOverride: fact.value, surface: "list")
            } else if let field,
                let color = FieldGuideMetrics.optionColor(
                    EntityFieldValue.optionColor(in: row.raw, field: field, surface: "list"))
            {
                StatusChip(
                    text: "\(fact.label ?? field.label): \(fact.value)", color: color)
            } else {
                Text("\(fact.label ?? field?.label ?? fact.id): \(fact.value)")
                    .font(.caption)
                    .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            }
            if let source = fact.source {
                Text("(\(source))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let field, field.explanation != nil, fact.id != "dataQuality" {
                FieldExplanationLabel(
                    field: field, subject: EntityRef(entity: key, id: row.id),
                    labelOverride: "About \(field.label)", surface: "list")
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private var supportingBand: some View {
        if presentation.facts.isEmpty && row.pendingFields.isEmpty && row.failedFields.isEmpty && !photoMode {
            EmptyView()
        } else if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                ForEach(presentation.facts) { fact in factView(fact) }
                if !row.pendingFields.isEmpty {
                    Text("Loading details…").font(.caption).foregroundStyle(.secondary)
                } else if !row.failedFields.isEmpty {
                    Text("Some details unavailable").font(.caption).foregroundStyle(.secondary)
                }
                if photoMode {
                    Text(presentation.shortcode).font(.caption2.monospaced())
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ScrollView(.horizontal) {
                HStack(spacing: FieldGuideTokens.Space.sm) {
                    ForEach(presentation.facts) { fact in factView(fact) }
                    if !row.pendingFields.isEmpty {
                        Text("Loading details…").font(.caption).foregroundStyle(.secondary)
                    } else if !row.failedFields.isEmpty {
                        Text("Some details unavailable").font(.caption).foregroundStyle(.secondary)
                    }
                    if photoMode {
                        Text(presentation.shortcode).font(.caption2.monospaced())
                    }
                }
                .frame(minHeight: FieldGuideTokens.touchTarget)
            }
            .scrollIndicators(.hidden)
        }
    }

    var body: some View {
        HStack(spacing: FieldGuideTokens.Space.md) {
            if let previewImage {
                previewImage
                    .resizable()
                    .scaledToFill()
                    .frame(width: thumbnailSize, height: thumbnailSize)
                    .clipShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusControl))
                    .accessibilityHidden(true)
            } else if let imageURL = presentation.imageURL {
                Thumb(
                    url: imageURL, size: thumbnailSize, symbol: EntityCatalog[key].recordSymbol(in: row),
                    emoji: EntityCatalog[key].recordEmoji(in: row))
            } else if row.pendingFields.contains("displayImages") {
                Thumb(
                    url: nil, size: thumbnailSize, symbol: EntityCatalog[key].recordSymbol(in: row),
                    emoji: EntityCatalog[key].recordEmoji(in: row))
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    if presentation.imageURL == nil, let emoji = EntityCatalog[key].recordEmoji(in: row) {
                        Text(emoji).accessibilityHidden(true)
                    } else if presentation.imageURL == nil, EntityCatalog[key].recordIconEntityField != nil {
                        Image(systemName: EntityCatalog[key].recordSymbol(in: row)).accessibilityHidden(true)
                    }
                    Text(presentation.title)
                        .accessibilityIdentifier("entity.row.title.\(key.rawValue).\(row.id)")
                }
                .font(.body.weight(.semibold))
                .foregroundStyle(FieldGuideTokens.graphite)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                supportingBand
            }
            Spacer(minLength: FieldGuideTokens.Space.sm)
        }
        .padding(.vertical, FieldGuideTokens.Space.xs)
        .frame(minHeight: 48, alignment: .center)
        .contentShape(Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            (photoMode
                ? "\(presentation.accessibilityText), \(presentation.shortcode)"
                : presentation.accessibilityText)
                + (row.pendingFields.isEmpty ? "" : ", Loading details")
                + (row.failedFields.isEmpty ? "" : ", Some details unavailable"))
    }
}

#Preview("Compact rows · image", traits: .modifier(SignedInPreview())) {
    List {
        EntityRowView(
            key: .product,
            row: PreviewFixtures.sampleRows[0],
            previewImage: Image(decorative: PreviewFixtures.sampleProbeImage, scale: 1))
    }
    .listStyle(.plain)
    .fieldGuideScreen()
}

#Preview("Rows", traits: .modifier(SignedInPreview())) {
    NavigationStack {
        List {
            ForEach(PreviewFixtures.sampleRows) { row in
                NavigationLink(value: Route.entityDetail(.product, id: row.id)) {
                    EntityRowView(key: .product, row: row)
                }
            }
        }
        .listStyle(.plain)
        .fieldGuideScreen()
        .navigationTitle("Products")
    }
}

#Preview("Compact rows · accessibility", traits: .modifier(SignedInPreview())) {
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
        .fieldGuideScreen()
        .preferredColorScheme(.dark)
        .environment(\.dynamicTypeSize, .accessibility3)
    }
}

@MainActor
private struct EntityTablePreviewHost: View {
    @State private var appModel: AppModel
    @State private var model: GenericEntityListModel

    init() {
        let appModel = PreviewFixtures.signedInModel()
        let rows = [
            PreviewFixtures.sampleDetailRow,
            EntityRow(
                id: "PRD-9999", title: "Carbon Steel Wok", subtitle: nil, imageURL: nil,
                raw: [
                    "id": "PRD-9999", "name": "Carbon Steel Wok",
                    "manufacturer": "Sample Maker", "categoryId": "CAT-4444",
                    "category": ["id": "CAT-4444", "name": "Cookware"],
                ]),
        ]
        let source = EntityListPageSource(id: "synthetic-table-preview") { page in
            ListPage(
                items: rows,
                meta: ListPageMeta(pageIndex: page, pageSize: 50, totalCount: rows.count))
        }
        _appModel = State(initialValue: appModel)  // state-init-ok: constant synthetic preview fixture
        _model = State(  // state-init-ok: constant synthetic preview fixture
            initialValue: GenericEntityListModel(
                descriptor: EntityCatalog[.product], client: appModel.client, source: source,
                view: .table))
    }

    var body: some View {
        NavigationStack {
            EntityListView(key: .product, model: model, presentation: .table)
        }
        .environment(appModel)
    }
}

#Preview("Generic table · injected product rows") {
    EntityTablePreviewHost()
}

#Preview("Generic table · accessibility") {
    EntityTablePreviewHost()
        .environment(\.dynamicTypeSize, .accessibility3)
}
