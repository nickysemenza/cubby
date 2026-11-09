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
    @Environment(\.openURL) private var openURL
    /// Regular-width iPad table columns take their declared `display.width` bucket and grow with
    /// Dynamic Type; the header and every row read the same widths, keeping columns aligned.
    @ScaledMetric(relativeTo: .body) private var tableColumnScale: CGFloat = 1
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
    @State private var rowActions = EntityRowActionRunner()
    @State private var selection = EntitySelectionController()
    #if os(iOS)
        @State private var editMode: EditMode = .inactive
    #endif
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
            .subtracting((descriptor.presentation.listRail ?? []).map(\.field))
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
        .environment(\.fieldExplanationListFilters, model?.filters ?? initialFilters)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                resultMembershipStatus
                // Both platforms show what is filtering the list; Mac otherwise hides it in View.
                if let model {
                    EntityFilterChipBar(
                        descriptor: descriptor, filters: model.filters, onEdit: { showingFilters = true }
                    ) { filters in
                        Task { await model.apply(filters: filters) }
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { selectionBar }
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
        .entityRowActionHost(rowActions)
        .entitySelectionHost(selection, descriptor: descriptor)
        #if os(iOS)
            .environment(\.editMode, $editMode)
            .onChange(of: editMode.isEditing) { _, editing in
                // A two-finger swipe enters editing on its own; leaving it always ends selection.
                if editing { selection.begin() } else { selection.end() }
            }
            .onChange(of: selection.isSelecting) { _, selecting in
                if !selecting, editMode.isEditing { editMode = .inactive }
            }
        #endif
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
            if selection.isSelecting {
                ToolbarItem(placement: .topBarLeading) {
                    let all = Set(visibleListRows.map(\.id))
                    Button(selection.selectedIDs == all && !all.isEmpty ? "Deselect All" : "Select All") {
                        selection.selectedIDs = selection.selectedIDs == all ? [] : all
                    }
                    .accessibilityIdentifier("browse.\(key.rawValue).select-all")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { endSelection() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("browse.\(key.rawValue).select-done")
                }
            } else {
                normalToolbar
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

    #if os(iOS)
        @ToolbarContentBuilder
        private var normalToolbar: some ToolbarContent {
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
        }
    #endif

    /// The rows the visible list presents: search results while searching, else the base rows.
    private var visibleListRows: [EntityRow] {
        guard let model else { return [] }
        return model.isSearching ? (model.searchModel?.rows ?? []) : model.rows
    }

    private var selectedRows: [EntityRow] {
        visibleListRows.filter { selection.selectedIDs.contains($0.id) }
    }

    /// Selection applies to the List and Table presentations; Cards and specialist views keep
    /// their own interaction.
    private var supportsSelection: Bool {
        guard let model, model.view == .table, key.nativeActions.contains(.list) else { return false }
        return !ActionPlacement.selectionBar(entity: descriptor, rows: []).isEmpty
    }

    private func beginSelection(_ row: EntityRow) {
        selection.begin(with: row.id)
        #if os(iOS)
            editMode = .active
        #endif
    }

    private func endSelection() {
        selection.end()
        #if os(iOS)
            editMode = .inactive
        #endif
    }

    /// The bottom selection bar: while selecting on iPhone and iPad, or for a multi-row Mac selection.
    @ViewBuilder
    private var selectionBar: some View {
        #if os(iOS)
            if selection.isSelecting {
                EntitySelectionBar(descriptor: descriptor, rows: selectedRows, controller: selection)
            }
        #else
            if selection.selectedIDs.count > 1 {
                EntitySelectionBar(descriptor: descriptor, rows: selectedRows, controller: selection)
            }
        #endif
    }

    private var hasControls: Bool {
        (model != nil && presentationChoices.count > 1) || !descriptor.filters.isEmpty
            || descriptor.primarySearch != nil || !descriptor.presentation.savedViews.isEmpty
            || !descriptor.sortFields.isEmpty || supportsSelection
    }

    @ViewBuilder
    private var controlsMenu: some View {
        if supportsSelection {
            Button("Select", systemImage: "checkmark.circle") {
                selection.begin()
                #if os(iOS)
                    editMode = .active
                #endif
            }
            .accessibilityIdentifier("browse.\(key.rawValue).select")
        }
        if let model, !descriptor.presentation.savedViews.isEmpty {
            savedViewsMenu(model)
        }
        if descriptor.primarySearch != nil {
            Button("Search", systemImage: "magnifyingglass") { searchPresented = true }
                .accessibilityIdentifier("browse.\(key.rawValue).search")
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
                listHandoffItems
                if !offersNativeTable {
                    OpenOnWebButton(
                        target: .route(path: "/\(descriptor.basePath)"), label: "Open table on web"
                    )
                    .accessibilityIdentifier("browse.\(key.rawValue).open-table-web")
                }
            }
        }
        if let model, !descriptor.sortFields.isEmpty {
            sortMenu(model)
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
                listHandoffItems
            }
            .accessibilityIdentifier("browse.\(key.rawValue).view-menu")
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

    @ViewBuilder
    private var listHandoffItems: some View {
        ForEach(descriptor.presentation.listViews, id: \.id) { view in
            if case .slot(let id, _, _) = view,
                let web = NativePresentationCoverage.listSlot(id).handoff
            {
                OpenOnWebButton(
                    target: .route(path: "/\(descriptor.basePath)", query: web.query),
                    label: web.label)
            }
        }
    }

    /// Declared sortable fields; choosing the active field again flips its direction.
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
        // Each declared total is labeled: two currency totals must not read as one repeated figure.
        let totals = descriptor.presentation.listTotals.map { total in
            "\(total.label) \(meta.totalLabels?[total.id] ?? "unavailable")"
        }
        return ([countSummary(meta)] + totals).joined(separator: " · ")
    }

    private func countSummary(_ meta: ListPageMeta) -> String {
        guard let totalCount = meta.totalCount else { return "Count unavailable" }
        let count = ValueFormat.count(Double(totalCount))
        if model?.resultMembership == .unresolved { return "\(count) unresolved" }
        if (meta.unresolvedCount ?? 0) > 0 { return "\(count) known" }
        return count
    }

    @ViewBuilder
    private var resultMembershipStatus: some View {
        if let model {
            let meta = model.isSearching ? model.searchModel?.summaryMeta : model.summaryMeta
            if model.resultMembership == .unresolved || (meta?.unresolvedCount ?? 0) > 0 {
                HStack(alignment: .firstTextBaseline, spacing: FieldGuideTokens.Space.sm) {
                    Text(
                        model.resultMembership == .unresolved
                            ? "Unresolved records"
                            : "Count incomplete · \(ValueFormat.count(Double(meta?.unresolvedCount ?? 0))) unresolved"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    if model.canSelectResultMembership {
                        Button {
                            Task {
                                await model.apply(
                                    resultMembership: model.resultMembership == .unresolved
                                        ? .known : .unresolved)
                            }
                        } label: {
                            Text(
                                model.resultMembership == .unresolved
                                    ? "Show known matches" : "Show unresolved"
                            )
                            #if os(iOS)
                                .frame(minHeight: 44)
                            #endif
                        }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("browse.\(key.rawValue).membership")
                    }
                }
                .padding(.horizontal, FieldGuideTokens.Space.md)
                .padding(.vertical, FieldGuideTokens.Space.xs)
                .background(.background)
                .overlay(alignment: .bottom) { Divider() }
            }
        }
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
        } else if let web = NativePresentationCoverage.listSlot(id).handoff {
            OpenOnWebButton(
                target: .route(path: "/\(descriptor.basePath)", query: web.query), label: web.label)
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

    private var browseSelection: Binding<RecordSelection?>? {
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

        private var singleTableSelection: String? {
            usesBrowseSelection ? appModel.navigator.selectedRecords[.browse]?.id : selectedTableRecordID
        }

        /// Multi-selection over the native table. One selected row is also the record the detail
        /// column shows; more than one keeps that detail and raises the selection bar.
        private var tableSelection: Binding<Set<String>> {
            Binding(
                get: {
                    selection.selectedIDs.count > 1
                        ? selection.selectedIDs : Set([singleTableSelection].compactMap { $0 })
                },
                set: { ids in
                    selection.selectedIDs = ids
                    guard ids.count <= 1 else { return }
                    let id = ids.first
                    if usesBrowseSelection {
                        browseSelection?.wrappedValue = id.map { RecordSelection(key: key, id: $0) }
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
        #if os(iOS)
            // Multi-selection: Select from Controls or a row's menu, or a two-finger swipe.
            List(selection: $selection.selectedIDs) { rows(model) }
                .listStyle(.plain)
                .navigationDestination(item: $openedRecord) { record in
                    RouteDestinationView(route: .entityDetail(record.key, id: record.id))
                }
        #else
            macRowList(model)
        #endif
    }

    #if os(macOS)
        @ViewBuilder
        private func macRowList(_ model: GenericEntityListModel) -> some View {
            List(selection: browseSelection) { rows(model) }
                .listStyle(.plain)
                .copyable(
                    copyItems(
                        browseSelection?.wrappedValue.flatMap { $0.key == key ? $0.id : nil },
                        in: model.isSearching ? (model.searchModel?.rows ?? []) : model.rows)
                )
                .navigationDestination(item: $openedRecord) { record in
                    RouteDestinationView(route: .entityDetail(record.key, id: record.id))
                }
        }
    #endif

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
            HStack(spacing: FieldGuideTokens.Space.xs) {
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
                    if descriptor.presentation.listRowCommand != nil {
                        TableColumn("") { (row: EntityRow) in
                            if let command = ActionPlacement(entity: descriptor, row: row).rowCommand {
                                RowCommandButton(action: command, key: key, row: row, runner: rowActions)
                                    .controlSize(.small)
                                    .frame(maxHeight: EntityTableLayout.cellContentHeight)
                                    .environment(cellAppModel)
                            }
                        }
                        .width(28)
                        .customizationID("rowCommand")
                        .disabledCustomizationBehavior(.visibility)
                    }
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
                                    section: section, entity: key, actions: actions(section),
                                    totals: EntityRowPresentation.railTotals(
                                        descriptor: descriptor, sums: section.sums))
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
                .copyable(copyItems(tableSelection.wrappedValue.first, in: visibleRows))
                .contextMenu(forSelectionType: String.self) { records in
                    let rows = visibleRows.filter { records.contains($0.id) }
                    if rows.count == 1, let row = rows.first {
                        EntityRowContextMenu(
                            placement: ActionPlacement(entity: descriptor, row: row), key: key, row: row,
                            runner: rowActions)
                    } else if rows.count > 1 {
                        ForEach(ActionPlacement.selectionBar(entity: descriptor, rows: rows)) { action in
                            Button(action.label, systemImage: action.symbol) {
                                selection.selectedIDs = records
                                selection.run(action, descriptor: descriptor, rows: rows, appModel: appModel)
                            }
                            .disabled(!action.enabled)
                        }
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
                            .frame(width: regularColumnWidth(nil), alignment: .leading)
                            ForEach(fields, id: \.key) { field in
                                sortHeading(
                                    field.columnHeader, accessibleTitle: field.label,
                                    key: sortKey(for: field), model: model
                                )
                                .frame(width: regularColumnWidth(field), alignment: .leading)
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
                                        section: section, entity: key, actions: actions(section),
                                        totals: EntityRowPresentation.railTotals(
                                            descriptor: descriptor, sums: section.sums))
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
        /// A regular-width iPad column's width: the field's declared `display.width` bucket (the
        /// title takes `lg`), scaled with Dynamic Type.
        private func regularColumnWidth(_ field: FieldDescriptor?) -> CGFloat {
            (field.map(EntityTableColumnWidth.init) ?? .title).ideal * tableColumnScale
        }

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
                        .frame(width: regularColumnWidth(nil), alignment: .leading)
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                        .contentShape(Rectangle())
                        .accessibilityIdentifier(
                            "browse.\(key.rawValue).table.row.\(row.id)")
                    }
                    .buttonStyle(.plain)
                    ForEach(fields, id: \.key) { field in
                        tableCell(field, row: row, fact: facts.first { $0.id == field.key })
                            .frame(width: regularColumnWidth(field), alignment: .leading)
                    }
                }
                .padding(.horizontal, FieldGuideTokens.Space.md)
                .frame(minHeight: FieldGuideTokens.touchTarget)
                .contentShape(Rectangle())
                .contextMenu {
                    EntityRowContextMenu(
                        placement: ActionPlacement(entity: descriptor, row: row), key: key, row: row,
                        runner: rowActions)
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
                        FieldProvenanceCaption(raw: row.raw, field: field)
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
            FieldValueStatus(raw: row.raw, field: field)
            if field.listRenderer == .dataQuality {
                if EntityRowPresentation.needsData(in: row) {
                    HStack(spacing: FieldGuideTokens.Space.xs) {
                        Circle().fill(FieldGuideTokens.warning).frame(width: 6, height: 6)
                        Text("Needs data")
                    }
                } else if let status = row.raw.recordValue("dataQuality")?["status"]?.stringValue {
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
                // The row's own trailing inset, so the totals sit over the rail columns.
                listSummary(meta: meta, filtered: !model.filters.isEmpty)
                    .listRowInsets(
                        EdgeInsets(
                            top: FieldGuideTokens.Space.xs, leading: FieldGuideTokens.Space.md,
                            bottom: FieldGuideTokens.Space.xs, trailing: FieldGuideTokens.Space.md))
            #endif
        }
        if let sections = model.sections {
            let actions = sectionActions(model)
            ForEach(sections) { section in
                Section {
                    listRows(section.rows)
                } header: {
                    EntityListSectionHeader(
                        section: section, entity: key, actions: actions(section),
                        totals: EntityRowPresentation.railTotals(descriptor: descriptor, sums: section.sums)
                    )
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
            let placement = ActionPlacement(entity: descriptor, row: row)
            rowContent(row, columns: columns, placement: placement)
                #if os(iOS)
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        ForEach(placement.leadingSwipe) { action in
                            PlacedActionItem(
                                action: action, key: key, row: row, runner: rowActions, inSwipe: true)
                        }
                    }
                    // Delete confirms first, so a full swipe never runs a trailing action.
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        ForEach(placement.trailingSwipe) { action in
                            PlacedActionItem(
                                action: action, key: key, row: row, runner: rowActions, inSwipe: true)
                        }
                    }
                    .tag(row.id)
                #endif
                .contextMenu {
                    EntityRowContextMenu(
                        placement: placement, key: key, row: row, runner: rowActions,
                        onSelect: supportsSelection ? beginSelection : { _ in })
                }
                .accessibilityIdentifier("browse.\(key.rawValue).row.\(row.id)")
        }
    }

    /// The count with the entity's noun ("8 products"), then the summed rail columns' totals over
    /// their columns.
    private func listSummary(meta: ListPageMeta, filtered: Bool) -> some View {
        let noun = (meta.totalCount == 1 ? descriptor.singular : descriptor.plural).lowercased()
        let count = meta.totalCount == nil ? countSummary(meta) : "\(countSummary(meta)) \(noun)"
        return EntityListSummary(
            text: ([count] + (filtered ? ["filtered"] : [])).joined(separator: " · "),
            totals: EntityRowPresentation.railTotals(descriptor: descriptor, labels: meta.totalLabels))
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

    /// One row: the optional row command, then the row's one link. While selecting, the row is
    /// plain so a tap toggles its selection mark.
    @ViewBuilder private func rowContent(
        _ row: EntityRow, columns: [String], placement: ActionPlacement
    ) -> some View {
        let command = selection.isSelecting ? nil : placement.rowCommand
        HStack(spacing: 0) {
            if let command {
                RowCommandButton(action: command, key: key, row: row, runner: rowActions)
            }
            Group {
                #if os(macOS)
                    if usesBrowseSelection {
                        EntityRowView(
                            key: key, row: row, columns: columns, showsFallbackImage: command == nil
                        )
                        .tag(RecordSelection(key: key, id: row.id))
                    } else {
                        rowLink(row, columns: columns, showsFallbackImage: command == nil)
                    }
                #else
                    if selection.isSelecting {
                        EntityRowView(key: key, row: row, columns: columns)
                    } else {
                        rowLink(row, columns: columns, showsFallbackImage: command == nil)
                    }
                #endif
            }
            .accessibilityHint(command.map(RowCommandGlyph.hint) ?? "")
            .accessibilityActions {
                if let command, command.enabled {
                    Button(command.label) {
                        rowActions.run(
                            command, key: key, row: row, appModel: appModel, openURL: openURL,
                            select: { _ in })
                    }
                }
            }
        }
        .listRowInsets(
            EdgeInsets(
                top: 0, leading: command == nil ? FieldGuideTokens.Space.md : FieldGuideTokens.Space.xs,
                bottom: 0, trailing: FieldGuideTokens.Space.md))
    }

    private func rowLink(_ row: EntityRow, columns: [String], showsFallbackImage: Bool = true) -> some View {
        Button {
            open(RecordSelection(key: key, id: row.id))
        } label: {
            EntityRowView(key: key, row: row, columns: columns, showsFallbackImage: showsFallbackImage)
        }
        .buttonStyle(.plain)
    }
}

@MainActor
private struct EntityTablePreviewHost: View {
    @State private var appModel: AppModel
    @State private var model: GenericEntityListModel

    init() {
        let appModel = PreviewFixtures.signedInModel()
        let rows =
            EntityScreenFixture.product.listPage.items + [
                EntityRow(
                    id: "PRD-9999", title: "Carbon Steel Wok", subtitle: nil, imageURL: nil,
                    raw: [
                        "id": "PRD-9999", "name": "Carbon Steel Wok",
                        "brandId": "VEN-2345", "brandName": "Sample Maker", "categoryId": "CAT-4444",
                        "category": ["id": "CAT-4444", "name": "Cookware"],
                        "owners": [
                            [
                                "label": "Alex",
                                "ref": ["entityKind": "ledgerParty", "entityId": "LPY-4K7M"],
                                "inherited": true,
                            ],
                            ["label": "Household", "ref": .null, "inherited": false],
                        ],
                    ])
            ]
        let source = EntityListPageSource(id: "synthetic-table-preview") { page in
            ListPage(
                items: rows,
                meta: ListPageMeta(pageIndex: page, pageSize: 50, totalCount: rows.count, hasNextPage: false))
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
