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
    let plural: String
    var focused: FocusState<Bool>.Binding

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            #if os(iOS)
                content.searchable(
                    text: $text, isPresented: $isPresented, placement: .navigationBarDrawer, prompt: prompt)
            #else
                // Edit › Find (⌘F) filters this list instead of leaving it for global Search.
                content.searchable(text: $text, isPresented: $isPresented, prompt: prompt)
                    .searchFocused(focused)
                    .focusedSceneValue(
                        \.listSearch, ListSearchAction(plural: plural) { focused.wrappedValue = true })
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
    /// Regular-width iPad table columns grow with Dynamic Type; compact width uses List or Cards.
    /// The header and every row read the same metrics, keeping columns aligned.
    @ScaledMetric(relativeTo: .body) private var titleColumnWidth: CGFloat = 240
    @ScaledMetric(relativeTo: .body) private var fieldColumnWidth: CGFloat = 180
    #if os(iOS)
        @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @State private var model: GenericEntityListModel?
    @State private var showingFilters = false
    @State private var creating = false
    @State private var searchText = ""
    @State private var searchPresented = false
    @FocusState private var searchFieldFocused: Bool
    @State private var retainedSearchText = ""
    @State private var clearingSearchExplicitly = false
    @State private var cardDensity = ListPresentationChoice.cards
    @State private var browsePresentation = BrowsePresentation.list
    @State private var hiddenTableColumns = Set<String>()
    #if os(macOS)
        /// Column hides, order and widths per entity, restored with the window.
        @SceneStorage private var columnCustomization: TableColumnCustomization<EntityRow>
    #endif
    @State private var quickActions = RowQuickActionRunner()
    @State private var selectedTableRecordID: String?
    @State private var openedRecord: RecordSelection?
    private let initialFilters: EntityFilterState
    private let initialSavedView: SavedView?
    private let usesBrowseSelection: Bool

    init(
        key: EntityKey, filters: EntityFilterState = EntityFilterState(), savedViewID: String? = nil,
        model: GenericEntityListModel? = nil,
        presentation: BrowsePresentation = .list,
        usesBrowseSelection: Bool = false
    ) {
        self.key = key
        self.initialFilters = filters
        self.initialSavedView = savedViewID.flatMap { id in
            EntityCatalog[key].presentation.savedViews.first { $0.id == id }
        }
        self.usesBrowseSelection = usesBrowseSelection
        // Reached via `.navigationDestination(for: Route.self)` (`Route.entityList`, a fresh
        // path entry per distinct `key`/`filters`) or, on macOS, `.id(key)`-scoped in
        // `RootSplitView` — both guarantee a full remount, never a stale `model` reused in place.
        _model = State(initialValue: model)  // state-init-ok
        _browsePresentation = State(initialValue: presentation)  // state-init-ok: route-scoped lifetime
        _hiddenTableColumns = State(  // state-init-ok: manifest defaults for this route's entity
            initialValue: Self.defaultHiddenTableColumns(EntityCatalog[key]))
        #if os(macOS)
            _columnCustomization = SceneStorage(
                wrappedValue: TableColumnCustomization<EntityRow>(), "cubby.table.\(key.rawValue)")
        #endif
    }

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    /// Table columns start hidden where the manifest declares `listHidden`, except a relation's
    /// context fields, which stand in for a column web shows.
    private static func defaultHiddenTableColumns(_ descriptor: EntityDescriptor) -> Set<String> {
        Set(descriptor.fields.filter(\.listHidden).map(\.key))
            .subtracting(EntityRowPresentation.listContextKeys(descriptor: descriptor))
    }

    /// Filtering by the coverage registry keeps an entity-qualified slot from being mistaken
    /// for a built-in view during initial selection or picker changes.
    private var renderableViews: [ListView] {
        NativePresentationCoverage.listViews(for: descriptor)
    }

    private var offersNativeTable: Bool {
        #if os(iOS)
            horizontalSizeClass == .regular
        #else
            true
        #endif
    }

    private var presentationChoices: [PresentationChoice] {
        if !offersNativeTable {
            return [
                PresentationChoice(
                    id: "list", label: "List", symbol: "list.bullet",
                    view: .table, density: nil, browsePresentation: .list),
                PresentationChoice(
                    id: ListPresentationChoice.cards.rawValue, label: "Cards", symbol: "rectangle.grid.2x2",
                    view: .shelf, density: .cards, browsePresentation: nil),
            ]
        }

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
                case .board, .slot:
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
        #if os(macOS)
            .navigationSubtitle(Text(toolbarSubtitle))
        #endif
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
                    ?? "Search \(descriptor.plural.lowercased()) or shortcode",
                plural: descriptor.plural,
                focused: $searchFieldFocused
            )
        )
        .onChange(of: searchText) { _, value in applySearchText(value) }
        .toolbar { toolbarContent }
        .task(id: key) {
            if model == nil {
                // A saved view (else the route's filters, else the declared `initialFilters`) opens
                // the list in its own query and view mode in one step, so no unscoped first page
                // is ever requested.
                model = GenericEntityListModel(
                    descriptor: descriptor, client: appModel.client,
                    sort: initialSavedView?.sortParameter,
                    filters: descriptor.openingFilters(savedView: initialSavedView, explicit: initialFilters),
                    view: initialSavedView?.listView(in: descriptor) ?? renderableViews.first ?? .table,
                    groupDimensions: initialSavedView?.groupBy)
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
        .rowQuickActionHost(quickActions)
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
            if key.nativeActions.contains(.create), hasControls {
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
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
            if let model {
                ToolbarItem(placement: .primaryAction) {
                    macViewMenu(model)
                }
            }
            if key.nativeActions.contains(.create) {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        creating = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .help("New \(descriptor.singular)")
                    .accessibilityLabel("New \(descriptor.singular)")
                    .accessibilityIdentifier("browse.\(key.rawValue).create")
                }
            }
        #endif
    }

    private var hasControls: Bool {
        (model != nil && presentationChoices.count > 1) || !descriptor.filters.isEmpty
            || descriptor.primarySearch != nil || !descriptor.presentation.savedViews.isEmpty
    }

    @ViewBuilder
    private var controlsMenu: some View {
        if let model, !descriptor.presentation.savedViews.isEmpty {
            savedViewsMenu(model)
        }
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
                if !offersNativeTable {
                    OpenOnWebButton(
                        target: .route(path: "/\(descriptor.basePath)"), label: "Open table on web"
                    )
                    .accessibilityIdentifier("browse.\(key.rawValue).open-table-web")
                }
            }
        }
        if let model, !descriptor.grouping.isEmpty {
            groupByMenu(model)
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

    #if os(macOS)
        private func macViewMenu(_ model: GenericEntityListModel) -> some View {
            Menu("View", systemImage: "slider.horizontal.3") {
                if !descriptor.sortFields.isEmpty {
                    sortMenu(model)
                }
                if !descriptor.grouping.isEmpty {
                    groupByMenu(model)
                }
                if !descriptor.presentation.savedViews.isEmpty {
                    savedViewsMenu(model)
                }
                if !descriptor.filters.isEmpty {
                    Button {
                        showingFilters = true
                    } label: {
                        Label(filterAccessibilityLabel, systemImage: "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityIdentifier("browse.\(key.rawValue).filter")
                }
                if !allTableFields.isEmpty {
                    columnsMenu
                }
            }
            .accessibilityIdentifier("browse.\(key.rawValue).view-menu")
        }

        private func sortMenu(_ model: GenericEntityListModel) -> some View {
            Menu("Sort", systemImage: "arrow.up.arrow.down") {
                if model.sort != nil {
                    Button("Clear sort") { Task { await model.apply(sort: nil) } }
                }
                ForEach(descriptor.sortFields, id: \.self) { fieldKey in
                    let active = model.sort == fieldKey || model.sort == "-\(fieldKey)"
                    let descending = model.sort == "-\(fieldKey)"
                    let label = descriptor.field(fieldKey)?.label ?? fieldKey
                    Button {
                        let next = model.sort == fieldKey ? "-\(fieldKey)" : fieldKey
                        Task { await model.apply(sort: next) }
                    } label: {
                        if active {
                            Label(
                                "\(label) · \(descending ? "Descending" : "Ascending")",
                                systemImage: "checkmark")
                        } else {
                            Text(label)
                        }
                    }
                    .accessibilityIdentifier("browse.\(key.rawValue).sort-menu.\(fieldKey)")
                }
            }
            .accessibilityIdentifier("browse.\(key.rawValue).sort-menu")
        }

        private var columnsMenu: some View {
            Menu("Columns", systemImage: "tablecells") {
                ForEach(allTableFields, id: \.key) { field in
                    Toggle(
                        field.label,
                        isOn: Binding(
                            get: {
                                switch columnCustomization[visibility: field.key] {
                                case .visible: true
                                case .hidden: false
                                default: !hiddenTableColumns.contains(field.key)
                                }
                            },
                            set: { columnCustomization[visibility: field.key] = $0 ? .visible : .hidden })
                    )
                    .accessibilityIdentifier("browse.\(key.rawValue).column.\(field.key)")
                }
            }
            .accessibilityLabel("Show or hide table columns")
            .accessibilityIdentifier("browse.\(key.rawValue).columns")
        }
    #endif

    /// Every declared Group by choice; one that cannot group stays listed, disabled, with its
    /// reason as the subtitle. While the list cannot group (Timeline, search), every choice
    /// shows that reason. A list whose choices can nest adds the hierarchy levels beside them,
    /// disabled with the reason when the active choice has none.
    private func groupByMenu(_ model: GenericEntityListModel) -> some View {
        let unavailable = model.groupByUnavailableReason
        return Menu("Group by", systemImage: "rectangle.grid.1x2") {
            Button {
                Task { await model.apply(groupBy: nil) }
            } label: {
                if model.groupChoice == nil && unavailable == nil {
                    Label("None", systemImage: "checkmark")
                } else {
                    Text("None")
                }
            }
            .accessibilityIdentifier("browse.\(key.rawValue).group.none")
            ForEach(descriptor.grouping) { choice in
                let reason = unavailable ?? choice.reason
                Button {
                    Task { await model.apply(groupBy: choice.id) }
                } label: {
                    if model.groupChoice?.id == choice.id {
                        Label(choice.label, systemImage: "checkmark")
                    } else {
                        Text(choice.label)
                    }
                    if let reason { Text(reason) }
                }
                .disabled(reason != nil)
                .accessibilityIdentifier("browse.\(key.rawValue).group.\(choice.id)")
            }
            if descriptor.grouping.contains(where: { $0.levels > 0 }) {
                groupLevelSection(model)
            }
        }
        .accessibilityIdentifier("browse.\(key.rawValue).group-by")
    }

    @ViewBuilder
    private func groupLevelSection(_ model: GenericEntityListModel) -> some View {
        Section("Level") {
            if let reason = model.groupLevelUnavailableReason {
                Button {
                } label: {
                    Text("By level")
                    Text(reason)
                }
                .disabled(true)
                .accessibilityIdentifier("browse.\(key.rawValue).group-level.unavailable")
            } else if let choice = model.groupChoice {
                let levels: [Int?] = [nil] + (1...max(1, choice.levels)).map { $0 }
                ForEach(levels, id: \.self) { level in
                    let label =
                        level.map { $0 == 1 ? "Top level" : "Level \($0)" }
                        ?? "Exact \(choice.label.lowercased())"
                    Button {
                        Task { await model.apply(groupLevel: level) }
                    } label: {
                        if model.activeGroupLevel == level {
                            Label(label, systemImage: "checkmark")
                        } else {
                            Text(label)
                        }
                    }
                    .accessibilityIdentifier(
                        "browse.\(key.rawValue).group-level.\(level.map(String.init) ?? "exact")")
                }
            }
        }
    }

    /// A section header's "Filter to this" and "Hide", each nil when the choice's filter cannot
    /// express it for that section.
    private func sectionActions(
        _ model: GenericEntityListModel
    ) -> (EntityListSection) -> EntityListSectionHeader.Actions {
        { section in
            guard let choice = model.groupChoice else { return .init() }
            var actions = EntityListSectionHeader.Actions()
            if model.groupDimensions.count == 1
                && descriptor.filtering(model.filters, to: section, of: choice) != nil
            {
                actions.filter = { Task { await model.filter(to: section) } }
            }
            if model.groupDimensions.count == 1
                && descriptor.hiding(model.filters, section: section, of: choice) != nil
            {
                actions.hide = { Task { await model.hide(section) } }
            }
            return actions
        }
    }

    private func savedViewsMenu(_ model: GenericEntityListModel) -> some View {
        Menu("Saved views", systemImage: "line.3.horizontal.decrease.circle") {
            ForEach(descriptor.presentation.savedViews) { savedView in
                Button {
                    Task { await model.apply(savedView: savedView) }
                } label: {
                    if model.activeSavedView?.id == savedView.id {
                        Label(savedView.label, systemImage: "checkmark")
                    } else {
                        Text(savedView.label)
                    }
                }
                .accessibilityIdentifier("browse.\(key.rawValue).saved-view.\(savedView.id)")
            }
        }
        .accessibilityIdentifier("browse.\(key.rawValue).saved-views")
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

    private var toolbarSubtitle: String {
        guard let model else { return "" }
        let meta = model.isSearching ? model.searchModel?.summaryMeta : model.summaryMeta
        guard let meta else { return "" }
        let totals = descriptor.presentation.listTotals.map { total in
            meta.totalLabels?[total.id] ?? "Unavailable"
        }
        return ([meta.totalCount.formatted()] + totals).joined(separator: " · ")
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
        if let slot = ImplementedListSlotID(rawValue: id) {
            ListSlotRegistry.view(slot, client: appModel.client, filters: filters)
        } else {
            ContentUnavailableView("View unavailable", systemImage: "square.dashed")
        }
    }

    private func specialistFilters(_ model: GenericEntityListModel) -> EntityFilterState {
        var filters = model.filters
        if let query = model.searchModel?.query, !query.isEmpty {
            filters.set([query], for: "search")
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
                case .timeline, .board, .slot: model.view.id
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
        if case .board(let spec) = model.view {
            EntityBoardListView(
                descriptor: descriptor, spec: spec, client: appModel.client, filters: specialistFilters(model)
            )
        } else if case .slot(let id, _, _) = model.view {
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
                    #if !os(macOS)
                        if let meta = model.summaryMeta {
                            listSummary(meta: meta, filtered: !model.filters.isEmpty)
                        }
                    #endif
                    // Unfiltered copy and the create label are the declared `emptyState`, as on web.
                    let empty = descriptor.emptyState
                    ContentUnavailableView {
                        Label(
                            model.filters.isEmpty ? empty.title : "No matching \(descriptor.plural)",
                            systemImage: entitySymbol(for: key))
                    } description: {
                        if model.filters.isEmpty { Text(empty.description) }
                    } actions: {
                        if !model.filters.isEmpty {
                            Button("Clear filters") {
                                Task { await model.apply(filters: EntityFilterState()) }
                            }
                        } else if let actionLabel = empty.actionLabel, key.nativeActions.contains(.create) {
                            Button(actionLabel) { creating = true }
                                .accessibilityIdentifier("browse.\(key.rawValue).empty.create")
                        }
                    }
                }
            }
        } else if model.view == .shelf {
            cardGrid(model, rows: model.rows, meta: model.summaryMeta)
        } else if model.view == .table && browsePresentation == .table && offersNativeTable {
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
                        #if !os(macOS)
                            if let meta = search.summaryMeta {
                                listSummary(meta: meta, filtered: !model.filters.isEmpty)
                            }
                        #endif
                        ContentUnavailableView(
                            "No matching \(descriptor.plural)", systemImage: "magnifyingglass")
                    }
                }
            } else if model.view == .shelf {
                cardGrid(model, rows: search.rows, meta: search.summaryMeta)
            } else if model.view == .table && browsePresentation == .table && offersNativeTable {
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
                #if !os(macOS)
                    if let meta {
                        listSummary(meta: meta, filtered: !model.filters.isEmpty)
                            .padding(.horizontal, FieldGuideTokens.Space.md)
                            .padding(.top, FieldGuideTokens.Space.sm)
                    }
                #endif
                EntityShelfView(
                    descriptor: descriptor, rows: rows, density: cardDensity,
                    section: appModel.navigator.section,
                    usesColumn: usesBrowseSelection,
                    sections: model.sections,
                    sectionActions: sectionActions(model))
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
    }

    @ViewBuilder
    private func banner(_ model: GenericEntityListModel) -> some View {
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
                    set: { record in
                        if let record {
                            open(record)
                        } else {
                            appModel.navigator.selectRecord(nil, in: .browse)
                        }
                    }) : nil
        #else
            nil
        #endif
    }

    private func open(_ record: RecordSelection) {
        appModel.navigator.open(
            record,
            from: usesBrowseSelection
                ? .column(.browse, compactDestination: $openedRecord) : .stack($openedRecord))
    }

    #if os(macOS)
        /// Edit › Copy (⌘C) on the selected row puts its `RecordCopyText` on the pasteboard.
        private func copyItems(_ id: String?, in rows: [EntityRow]) -> [String] {
            guard let id, let row = rows.first(where: { $0.id == id }) else { return [] }
            return [RecordCopyText.text(key: key, id: id, title: row.title)]
        }

        private var tableSelection: Binding<String?> {
            Binding(
                get: {
                    usesBrowseSelection
                        ? appModel.navigator.selectedRecords[.browse]?.id : selectedTableRecordID
                },
                set: { id in
                    if usesBrowseSelection {
                        selection?.wrappedValue = id.map { RecordSelection(key: key, id: $0) }
                    } else {
                        selectedTableRecordID = id
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
        List(selection: selection) { rows(model) }
            .listStyle(.plain)
            #if os(macOS)
                .copyable(
                    copyItems(
                        selection?.wrappedValue.flatMap { $0.key == key ? $0.id : nil },
                        in: model.isSearching ? (model.searchModel?.rows ?? []) : model.rows))
            #endif
            .navigationDestination(item: $openedRecord) { record in
                RouteDestinationView(route: .entityDetail(record.key, id: record.id))
            }
    }

    private var tableFields: [FieldDescriptor] {
        allTableFields.filter { !hiddenTableColumns.contains($0.key) }
    }

    private var allTableFields: [FieldDescriptor] {
        descriptor.fields
            .filter {
                $0.showInList && $0.key != "id" && $0.key != descriptor.titleField
                    && ($0.kind != .json || $0.listRenderer != nil || $0.labelPath != nil
                        || $0.format != nil || $0.reference != nil || $0.mobileSlot != nil)
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

    /// A declared short header; the full label stays the accessible name.
    private func columnHeader(_ field: FieldDescriptor) -> Text {
        Text(field.columnHeader).accessibilityLabel(Text(field.label))
    }

    private func sortHeading(
        _ title: String, accessibleTitle: String? = nil, key: String?, model: GenericEntityListModel
    ) -> some View {
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
        .accessibilityLabel(
            key == nil ? accessibleTitle ?? title : "Sort by \(accessibleTitle ?? title)"
        )
        .accessibilityValue(
            key.map { model.sort == $0 ? "Ascending" : model.sort == "-\($0)" ? "Descending" : "Not sorted" }
                ?? ""
        )
        .accessibilityIdentifier(key.map { "browse.\(self.key.rawValue).sort.\($0)" } ?? "")
    }

    private func tableControls(_ model: GenericEntityListModel) -> some View {
        Group {
            if hasBanner(model) {
                banner(model)
            }
        }
    }

    private var tableTitleLabel: String {
        descriptor.fields.first(where: { $0.key == descriptor.titleField })?.label ?? descriptor.singular
    }

    private func tableTitle(_ row: EntityRow) -> some View {
        let titleParts = EntityRowPresentation.titleParts(descriptor: descriptor, row: row)
        let subtitle = [
            EntityRowPresentation.titleSubtitle(descriptor: descriptor, row: row)?.value,
            row.subtitle, titleParts.subtitle,
        ].compactMap { $0 }.first(where: EntityRowPresentation.isVisibleListFactValue)
        return EntityTableTitleCell(
            title: titleParts.title,
            subtitle: descriptor.presentation.titleSubtitle ? subtitle : nil,
            imageURL: row.imageURL, symbol: descriptor.recordSymbol(in: row),
            emoji: descriptor.recordEmoji(in: row)
        )
        .entityTableCell()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("browse.\(key.rawValue).table.row.\(row.id)")
    }

    @ViewBuilder
    private func tableView(_ model: GenericEntityListModel) -> some View {
        let visibleRows = model.isSearching ? (model.searchModel?.rows ?? []) : model.rows
        let visibleMeta = model.isSearching ? model.searchModel?.summaryMeta : model.summaryMeta
        let sections = model.sections
        let actions = sectionActions(model)
        let hasMore = model.isSearching ? (model.searchModel?.hasMore ?? false) : model.hasMore
        #if os(macOS)
            // Every column is declared so hides persist; manifest `listHidden` sets the default.
            let fields = allTableFields
            let defaultHidden = hiddenTableColumns
            // Native table cells are rehosted when sorting replaces the rows, so capture the
            // owning model before that boundary for their reference actions.
            let cellAppModel = appModel
        #else
            let fields = tableFields
        #endif
        VStack(spacing: 0) {
            tableControls(model)
            #if !os(macOS)
                if let visibleMeta {
                    listSummary(meta: visibleMeta, filtered: !model.filters.isEmpty)
                        .padding(.horizontal, FieldGuideTokens.Space.md)
                        .padding(.vertical, FieldGuideTokens.Space.xs)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("browse.\(key.rawValue).table.summary")
                }
            #endif
            #if os(macOS)
                Table(
                    of: EntityRow.self, selection: tableSelection, sortOrder: tableSortOrder(model),
                    columnCustomization: $columnCustomization
                ) {
                    if descriptor.sortFields.contains(descriptor.titleField) {
                        TableColumn(
                            Text(tableTitleLabel),
                            sortUsing: EntityRowFieldComparator(fieldKey: descriptor.titleField)
                        ) { row in
                            tableTitle(row)
                        }
                        .width(.title)
                        .customizationID("title")
                        .disabledCustomizationBehavior(.visibility)
                    }
                    if !descriptor.sortFields.contains(descriptor.titleField) {
                        TableColumn(Text(tableTitleLabel)) { (row: EntityRow) in
                            tableTitle(row)
                        }
                        .width(.title)
                        .customizationID("title")
                        .disabledCustomizationBehavior(.visibility)
                    }
                    TableColumnForEach(fields, id: \.key) { field in
                        if let sortKey = sortKey(for: field) {
                            TableColumn(
                                columnHeader(field), sortUsing: EntityRowFieldComparator(fieldKey: sortKey)
                            ) { row in
                                tableCell(field, row: row, fact: tableFact(field, row: row))
                                    .environment(cellAppModel)
                            }
                            .width(EntityTableColumnWidth(field))
                            .customizationID(field.key)
                            .defaultVisibility(defaultHidden.contains(field.key) ? .hidden : .automatic)
                        }
                        if sortKey(for: field) == nil {
                            TableColumn(columnHeader(field)) { (row: EntityRow) in
                                tableCell(field, row: row, fact: tableFact(field, row: row))
                                    .environment(cellAppModel)
                            }
                            .width(EntityTableColumnWidth(field))
                            .customizationID(field.key)
                            .defaultVisibility(defaultHidden.contains(field.key) ? .hidden : .automatic)
                        }
                    }
                } rows: {
                    if let sections {
                        ForEach(sections) { section in
                            Section {
                                ForEach(section.rows) { TableRow($0) }
                            } header: {
                                EntityListSectionHeader(
                                    section: section, entity: key, actions: actions(section))
                            }
                        }
                    } else {
                        ForEach(visibleRows) { TableRow($0) }
                    }
                    // Load more is the table's last row, so paging stays inside the scrolled
                    // content instead of a footer below it.
                    if hasMore {
                        Section {
                            ForEach([EntityRow]()) { TableRow($0) }
                        } header: {
                            HStack { loadMore(model) }.frame(maxWidth: .infinity)
                        }
                    }
                }
                .tableStyle(.inset(alternatesRowBackgrounds: true))
                .environment(\.defaultMinListRowHeight, EntityTableLayout.rowHeight)
                .copyable(copyItems(tableSelection.wrappedValue, in: visibleRows))
                .contextMenu(forSelectionType: String.self) { records in
                    if let id = records.first {
                        Button("Copy link", systemImage: "link") {
                            Clipboard.copy(appModel.webHandoff.url(.record(key: key, id: id)).absoluteString)
                        }
                        Button("Copy shortcode", systemImage: "number") { Clipboard.copy(id) }
                        ShareLink(item: appModel.webHandoff.url(.record(key: key, id: id)))
                    }
                } primaryAction: { records in
                    if !usesBrowseSelection, let id = records.first {
                        open(RecordSelection(key: key, id: id))
                    }
                }
                .accessibilityIdentifier("browse.\(key.rawValue).table")
            #else
                ScrollView([.horizontal, .vertical]) {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        HStack(spacing: 0) {
                            sortHeading(
                                tableTitleLabel,
                                key: descriptor.sortFields.contains(descriptor.titleField)
                                    ? descriptor.titleField : nil, model: model
                            )
                            .frame(width: titleColumnWidth, alignment: .leading)
                            ForEach(fields, id: \.key) { field in
                                sortHeading(
                                    field.columnHeader, accessibleTitle: field.label,
                                    key: sortKey(for: field), model: model
                                )
                                .frame(width: fieldColumnWidth, alignment: .leading)
                            }
                        }
                        .padding(.horizontal, FieldGuideTokens.Space.md)
                        .padding(.vertical, FieldGuideTokens.Space.sm)
                        .background(.quaternary.opacity(0.5))
                        if let sections {
                            ForEach(sections) { section in
                                Section {
                                    ForEach(section.rows) { row in regularTableRow(row, fields: fields) }
                                } header: {
                                    EntityListSectionHeader(
                                        section: section, entity: key, actions: actions(section))
                                }
                            }
                        } else {
                            ForEach(visibleRows) { row in regularTableRow(row, fields: fields) }
                        }
                    }
                }
                .accessibilityIdentifier("browse.\(key.rawValue).table")
            #endif
            #if !os(macOS)
                if hasMore {
                    loadMore(model)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, FieldGuideTokens.Space.sm)
                }
            #endif
        }
        .navigationDestination(item: $openedRecord) { record in
            RouteDestinationView(route: .entityDetail(record.key, id: record.id))
        }
    }

    #if !os(macOS)
        private func regularTableRow(_ row: EntityRow, fields: [FieldDescriptor]) -> some View {
            // A fact depends only on its own field, so one resolve serves every cell in the row.
            let facts = EntityRowPresentation.resolve(
                descriptor: descriptor, row: row, columns: fields.map(\.key)
            ).facts
            let declaredTitleSubtitle =
                EntityRowPresentation.titleSubtitle(
                    descriptor: descriptor, row: row)?.value ?? row.subtitle
            let titleParts = EntityRowPresentation.titleParts(
                descriptor: descriptor, row: row, subtitle: declaredTitleSubtitle)
            let titleSubtitle = [declaredTitleSubtitle, titleParts.subtitle].compactMap { $0 }
                .first(where: EntityRowPresentation.isVisibleListFactValue)
            return VStack(spacing: 0) {
                HStack(spacing: 0) {
                    Button {
                        open(RecordSelection(key: key, id: row.id))
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(titleParts.title)
                                .font(.body.weight(.medium))
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                                .truncationMode(.tail)
                            if let subtitle = titleSubtitle {
                                Text(subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        }
                        .frame(width: titleColumnWidth, alignment: .leading)
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                        .contentShape(Rectangle())
                        .accessibilityIdentifier(
                            "browse.\(key.rawValue).table.row.\(row.id)")
                    }
                    .buttonStyle(.plain)
                    ForEach(fields, id: \.key) { field in
                        tableCell(field, row: row, fact: facts.first { $0.id == field.key })
                            .frame(width: fieldColumnWidth, alignment: .leading)
                    }
                }
                .padding(.horizontal, FieldGuideTokens.Space.md)
                .frame(minHeight: FieldGuideTokens.touchTarget)
                .contentShape(Rectangle())
                .contextMenu {
                    RowQuickActionButtons(key: key, row: row, runner: quickActions)
                    Button("Copy link", systemImage: "link") {
                        Clipboard.copy(appModel.webHandoff.url(.record(key: key, id: row.id)).absoluteString)
                    }
                    Button("Copy shortcode", systemImage: "number") { Clipboard.copy(row.id) }
                    ShareLink(item: appModel.webHandoff.url(.record(key: key, id: row.id)))
                }
                Divider()
            }
        }
    #endif

    @ViewBuilder
    private func tableReference(_ reference: EntityFieldValue.Reference, value: String) -> some View {
        let label = Text(value)
            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            .frame(
                minWidth: FieldGuideTokens.touchTarget,
                minHeight: tableCellMinimumHeight, alignment: .leading
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

    private var tableCellMinimumHeight: CGFloat? {
        #if os(macOS)
            nil
        #else
            FieldGuideTokens.touchTarget
        #endif
    }

    #if os(macOS)
        private func tableFact(_ field: FieldDescriptor, row: EntityRow) -> EntityRowPresentation.Fact? {
            EntityRowPresentation.fact(field.key, descriptor: descriptor, row: row)
        }
    #endif

    /// Mac cells are one line: the provenance caption iPhone stacks below a value is dropped,
    /// and only a cell with an action (a reference) takes keyboard focus.
    @ViewBuilder
    private func tableCell(
        _ field: FieldDescriptor, row: EntityRow, fact: EntityRowPresentation.Fact?
    ) -> some View {
        Group {
            if let reason = field.displayApplicabilityRefusal(in: row.raw) {
                Text("—").foregroundStyle(.tertiary)
                    .help(reason)
                    .accessibilityLabel("\(field.label): Not applicable. \(reason)")
            } else if let fact {
                #if os(macOS)
                    tableValue(field, row: row, fact: fact)
                #else
                    VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                        tableValue(field, row: row, fact: fact)
                        DerivedProvenanceCaption(raw: row.raw, field: field.key)
                    }
                #endif
            } else {
                Text("—").foregroundStyle(.tertiary)
            }
        }
        #if os(macOS)
            .entityTableCell()
        #else
            .frame(minHeight: tableCellMinimumHeight, alignment: .leading)
        #endif
    }

    @ViewBuilder
    private func tableValue(
        _ field: FieldDescriptor, row: EntityRow, fact: EntityRowPresentation.Fact
    ) -> some View {
        HStack(spacing: FieldGuideTokens.Space.xs) {
            DerivedValueStatus(raw: row.raw, field: field.key)
            if field.listRenderer == .dataQuality {
                if EntityRowPresentation.needsData(in: row) {
                    HStack(spacing: FieldGuideTokens.Space.xs) {
                        Circle().fill(.orange).frame(width: 6, height: 6)
                        Text("Needs data")
                    }
                } else if let status = row.raw["dataQuality"]?["status"]?.stringValue {
                    Text(field.valueOptions?.first { $0.value == status }?.label ?? status)
                }
            } else if let reference = EntityFieldValue.reference(
                in: row.raw, field: field, surface: "list")
            {
                tableReference(reference, value: fact.value)
                    .buttonStyle(.borderless)
                    .accessibilityIdentifier(
                        "browse.\(key.rawValue).table.reference.\(row.id).\(field.key)")
                if fact.inherited { InheritedMarker() }
            } else if let option = EntityFieldValue.option(
                in: row.raw, field: field, surface: "list"),
                let chip = StatusChip(text: fact.value, option: option)
            {
                chip
            } else {
                Group {
                    if let date = fact.dateValue {
                        #if os(macOS)
                            DateDisplay(date, compact: true)
                        #else
                            DateDisplay(date, compact: true, stacked: true)
                        #endif
                    } else {
                        InheritedMarker.text(fact.segments)
                            .accessibilityLabel(fact.spokenValue)
                    }
                }
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(FieldGuideTokens.graphiteSecondary)
            }
        }
    }

    @ViewBuilder
    private func rows(_ model: GenericEntityListModel) -> some View {
        if hasBanner(model) { Section { banner(model) } }
        let visibleRows = model.isSearching ? (model.searchModel?.rows ?? []) : model.rows
        let visibleMeta = model.isSearching ? model.searchModel?.summaryMeta : model.summaryMeta
        if let meta = visibleMeta {
            #if !os(macOS)
                listSummary(meta: meta, filtered: !model.filters.isEmpty)
            #endif
        }
        if let sections = model.sections {
            let actions = sectionActions(model)
            ForEach(sections) { section in
                Section {
                    listRows(section.rows)
                } header: {
                    EntityListSectionHeader(section: section, entity: key, actions: actions(section))
                        .listRowInsets(EdgeInsets())
                }
            }
        } else {
            listRows(visibleRows)
        }
        if model.isSearching ? (model.searchModel?.hasMore ?? false) : model.hasMore { loadMore(model) }
    }

    private func listRows(_ rows: [EntityRow]) -> some View {
        let columns = EntityRowPresentation.defaultColumns(descriptor: descriptor)
        return ForEach(rows) { row in
            rowContent(row, columns: columns)
                #if os(iOS)
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        RowQuickActionButtons(key: key, row: row, runner: quickActions)
                    }
                #endif
                .contextMenu {
                    RowQuickActionButtons(key: key, row: row, runner: quickActions)
                    Button("Copy link", systemImage: "link") {
                        Clipboard.copy(appModel.webHandoff.url(.record(key: key, id: row.id)).absoluteString)
                    }
                    Button("Copy shortcode", systemImage: "number") { Clipboard.copy(row.id) }
                    ShareLink(item: appModel.webHandoff.url(.record(key: key, id: row.id)))
                }
                .accessibilityIdentifier("browse.\(key.rawValue).row.\(row.id)")
        }
    }

    private func listSummary(meta: ListPageMeta, filtered: Bool) -> some View {
        let totals = descriptor.presentation.listTotals.compactMap {
            meta.totalLabels?[$0.id]
        }.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let summary = ([meta.totalCount.formatted()] + totals + (filtered ? ["filtered"] : []))
            .joined(separator: " · ")
        return Text(summary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(summary)
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

    @ViewBuilder private func rowContent(_ row: EntityRow, columns: [String]) -> some View {
        Group {
            #if os(macOS)
                if usesBrowseSelection {
                    EntityRowView(key: key, row: row, columns: columns)
                        .tag(RecordSelection(key: key, id: row.id))
                } else {
                    Button {
                        open(RecordSelection(key: key, id: row.id))
                    } label: {
                        EntityRowView(key: key, row: row, columns: columns)
                    }
                    .buttonStyle(.plain)
                }
            #else
                Button {
                    open(RecordSelection(key: key, id: row.id))
                } label: {
                    EntityRowView(key: key, row: row, columns: columns)
                }
                .buttonStyle(.plain)
            #endif
        }
        .listRowInsets(
            EdgeInsets(
                top: 0, leading: FieldGuideTokens.Space.md, bottom: 0, trailing: FieldGuideTokens.Space.md))
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
        if EntityCatalog[key].field("dataQuality") != nil,
            EntityRowPresentation.needsData(
                in: EntityRow(id: id, title: "", subtitle: nil, imageURL: nil, raw: raw))
        {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                Circle().fill(.orange).frame(width: 6, height: 6)
                Text("Needs data")
            }
            .font(.caption.weight(.medium))
            .accessibilityLabel("Needs data")
        }
    }
}

struct EntityRowView: View {
    let key: EntityKey
    let row: EntityRow
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var columns: [String]? = nil
    var photoMode = false
    /// Preview-only image injection keeps the production row on the shared URL-backed Thumb
    /// while allowing previews to exercise the real image geometry and clipping.
    var previewImage: Image? = nil

    /// One manifest projection feeds both visible lines and the complete spoken row label.
    private struct Layout {
        let presentation: EntityRowPresentation
        let title: String
        let trailingValue: EntityRowPresentation.Fact?
        let date: EntityRowPresentation.Fact?
        let subtitle: EntityRowPresentation.Fact?
        let subtitleText: String?
        let contextFacts: [EntityRowPresentation.Fact]
        let needsData: Bool
    }

    private var layout: Layout {
        let descriptor = EntityCatalog[key]
        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: columns, photoMode: photoMode)
        let titleSubtitle = EntityRowPresentation.titleSubtitle(descriptor: descriptor, row: row)
        let mobileSubtitle = presentation.facts.first {
            descriptor.field($0.id)?.mobileSlot == "subtitle"
        }
        let dated = presentation.facts.first { $0.isDate && $0.id != "dataQuality" }
        let leading = presentation.facts.filter { !$0.isDate && $0.id != "dataQuality" }.sorted {
            left, right in
            func priority(_ fact: EntityRowPresentation.Fact) -> Int {
                guard let field = descriptor.field(fact.id) else { return .max }
                if field.key == descriptor.presentation.heroChip { return -1 }
                if field.mobileSlot == "trailing" { return field.mobilePriority ?? 0 }
                return .max
            }
            return priority(left) < priority(right)
        }.first { fact in
            let field = descriptor.field(fact.id)
            return field?.key == descriptor.presentation.heroChip || field?.mobileSlot == "trailing"
        }
        let subtitle = [titleSubtitle, mobileSubtitle].compactMap { $0 }.first {
            EntityRowPresentation.isVisibleListFactValue($0.value)
        }
        let declaredSubtitle = titleSubtitle?.value ?? row.subtitle ?? mobileSubtitle?.value
        let titleParts = EntityRowPresentation.titleParts(
            descriptor: descriptor, row: row, subtitle: declaredSubtitle)
        let subtitleText =
            [titleSubtitle?.value, row.subtitle, mobileSubtitle?.value]
            .compactMap { $0 }
            .first(where: EntityRowPresentation.isVisibleListFactValue) ?? titleParts.subtitle
        let omitted = Set(
            ["dataQuality", leading?.id, dated?.id, subtitle?.id].compactMap { $0 })
        let contextFacts = presentation.facts.filter {
            !omitted.contains($0.id) && EntityRowPresentation.isVisibleListFactValue($0.value)
        }
        return Layout(
            presentation: presentation, title: titleParts.title,
            trailingValue: leading, date: dated,
            subtitle: subtitle,
            subtitleText: subtitleText.flatMap {
                EntityRowPresentation.isVisibleListFactValue($0) ? $0 : nil
            },
            contextFacts: Array(contextFacts.prefix(3)), needsData: EntityRowPresentation.needsData(in: row))
    }

    var body: some View {
        let layout = layout
        let presentation = layout.presentation
        RecordListRow(
            title: layout.title, imageURL: presentation.imageURL,
            symbol: EntityCatalog[key].recordSymbol(in: row), emoji: EntityCatalog[key].recordEmoji(in: row),
            previewImage: previewImage, titleIdentifier: "entity.row.title.\(key.rawValue).\(row.id)"
        ) {
            HStack(spacing: FieldGuideTokens.Space.xs) {
                DerivedValueStatus(raw: row.raw, field: nil)
                if layout.needsData {
                    Circle().fill(.orange).frame(width: 6, height: 6)
                }
                let facts =
                    ([layout.needsData ? "Needs data" : nil, layout.subtitleText]
                        .compactMap { $0 } + layout.contextFacts.map(\.value))
                if !facts.isEmpty {
                    Text(facts.prefix(3).joined(separator: " · "))
                        .lineLimit(1)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } rail: {
            if let value = layout.trailingValue {
                InheritedMarker.text(value.segments)
                    .monospacedDigit()
                    .accessibilityLabel(value.spokenValue)
            }
            if let date = layout.date?.dateValue {
                RelativeDateDisplay(value: date)
            }
        } supplement: {
            ForEach(presentation.facts) { fact in
                DerivedProvenanceCaption(raw: row.raw, field: fact.id)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            accessibilityText(for: layout) + (DerivedValueStatus.isUpdating(in: row.raw) ? ", Updating" : ""))
    }

    private func accessibilityText(for layout: Layout) -> String {
        let descriptor = EntityCatalog[key]
        var facts = [layout.title]
        if let value = layout.trailingValue {
            facts.append("\(descriptor.field(value.id)?.label ?? value.id): \(value.spokenValue)")
        }
        if layout.needsData { facts.append("Needs data") }
        if let subtitle = layout.subtitle {
            facts.append("\(descriptor.field(subtitle.id)?.label ?? subtitle.id): \(subtitle.spokenValue)")
        } else if let subtitleText = layout.subtitleText {
            facts.append(subtitleText)
        }
        facts += layout.contextFacts.map {
            "\(descriptor.field($0.id)?.label ?? $0.id): \($0.spokenValue)"
        }
        if let date = layout.date {
            let value = date.dateValue.flatMap { DatePresentation.value($0)?.text } ?? date.spokenValue
            facts.append("\(descriptor.field(date.id)?.label ?? date.id): \(value)")
        }
        if photoMode { facts.append(layout.presentation.shortcode) }
        return facts.joined(separator: ", ")
    }
}

private struct RelativeDateDisplay: View {
    let value: String
    @Environment(\.locale) private var locale

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            if let display = DatePresentation.value(value, now: context.date, compact: true, locale: locale) {
                Text(display.relative)
                    .monospacedDigit()
                    .help(display.exact)
                    .accessibilityLabel(display.text)
            } else {
                Text(value)
            }
        }
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
                        "brandId": "VEN-2345", "brandName": "Sample Manufacturer",
                        "updatedAt": "2026-09-12T10:00:00.000Z",
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
                    "brandId": "VEN-2345", "brandName": "Sample Maker", "categoryId": "CAT-4444",
                    "category": ["id": "CAT-4444", "name": "Cookware"],
                    "owners": [
                        [
                            "label": "Alex", "ref": ["entityKind": "ledgerParty", "entityId": "LPY-4K7M"],
                            "inherited": true,
                        ],
                        ["label": "Household", "ref": .null, "inherited": false],
                    ],
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
