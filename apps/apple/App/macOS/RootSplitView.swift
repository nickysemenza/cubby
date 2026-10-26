import AppKit
import CubbyKit
import SwiftUI

struct RootSplitView: View {
    @Environment(AppModel.self) private var model
    @SceneStorage("cubby.selectedSection") private var storedSection = AppSection.today.rawValue
    /// Manifest section ids; retain existing domain preferences across windows and launches.
    @AppStorage("cubby.sidebar.collapsedDomains") private var collapsedDomains = ""
    @AppStorage("cubby.sidebar.expandedSections") private var expandedSections = ""
    @SceneStorage("cubby.navigation") private var storedNavigation: Data?
    @SceneStorage("cubby.columnVisibility") private var storedVisibility: Data?
    @SceneStorage("cubby.detailVisible") private var detailVisible = true
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @State private var didRestoreSection = false
    @State private var browsing: NativeBrowserSession?
    @State private var refresh = SceneRefresh()
    @State private var creating: NewRecordRequest?

    private var isBrowser: Bool {
        model.navigator.section == .search || model.navigator.section == .browse
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
                .background {
                    SplitColumnCollapse(
                        contentCollapsed: !usesContentColumn,
                        detailCollapsed: usesContentColumn && !detailVisible)
                }
        } content: {
            Group {
                if isBrowser {
                    browserList
                } else if model.navigator.section == .activity {
                    SectionView(section: .activity)
                }
            }
            .navigationSplitViewColumnWidth(min: 300, ideal: 460, max: 900)
        } detail: {
            if usesContentColumn {
                recordDetail
            } else {
                NavigationStack(path: model.navigator.path(for: model.navigator.section)) {
                    SectionView(section: model.navigator.section)
                }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItem {
                Button(detailVisible ? "Hide Detail" : "Show Detail", systemImage: "sidebar.right") {
                    detailVisible.toggle()
                }
                .keyboardShortcut("d", modifiers: [.option, .command])
                .disabled(!usesContentColumn)
                .help("Show or hide detail (⌥⌘D)")
            }
            ToolbarItem {
                Button("Refresh", systemImage: "arrow.clockwise") { refresh.refresh() }
                    .disabled(!refresh.isEnabled)
                    .help("Refresh (⌘R)")
            }
        }
        .environment(\.sceneRefresh, refresh)
        .focusedSceneValue(\.nativeRefresh, refresh.action)
        .focusedSceneValue(
            \.sceneCommands,
            SceneCommandActions(
                target: model.navigator.commandTarget,
                create: { creating = NewRecordRequest(key: $0) })
        )
        .sheet(item: $creating) { request in
            EntityEditorSheet(key: request.key, mode: .create(prefill: [:])) { id in
                model.navigator.open(.entity(request.key, id: id))
            }
            .environment(model)
        }
        .environment(
            \.sectionSelection,
            Binding(
                get: { model.navigator.section }, set: { model.navigator.section = $0 }
            )
        )
        .frame(minWidth: 720, minHeight: 480)
        .task {
            if browsing == nil { browsing = NativeBrowserSession(client: model.client) }
            guard !didRestoreSection else { return }
            didRestoreSection = true
            model.navigator.restore(section: storedSection, navigation: storedNavigation)
            if let storedVisibility,
                let visibility = try? JSONDecoder().decode(
                    NavigationSplitViewVisibility.self, from: storedVisibility)
            {
                columnVisibility = visibility
            }
            selectFirstRecord()
        }
        .onChange(of: model.navigator.section) { _, value in storedSection = value.rawValue }
        .onChange(of: model.navigator.restoration) { _, value in
            guard didRestoreSection else { return }
            storedNavigation = try? JSONEncoder().encode(value)
        }
        .onChange(of: columnVisibility) { _, value in
            storedVisibility = try? JSONEncoder().encode(value)
        }
        .onChange(of: visibleRecords, initial: true) { _, _ in selectFirstRecord() }
        .onChange(of: model.navigator.macDestination) { _, _ in selectFirstRecord() }
    }

    private var usesContentColumn: Bool { isBrowser || model.navigator.section == .activity }

    private var visibleRecords: [RecordSelection] {
        guard let browsing else { return [] }
        if model.navigator.section == .search {
            switch browsing.search.phase {
            case .results(let groups):
                return groups.flatMap { group in
                    group.hits.map { RecordSelection(key: group.key, id: $0.id) }
                }
            case .idle:
                return browsing.search.recents.map { RecordSelection(key: $0.key, id: $0.row.id) }
            default: return []
            }
        }
        guard model.navigator.section == .browse, let key = model.navigator.browseKey else { return [] }
        let list = browsing.list(for: key)
        let rows = list.isSearching ? list.searchModel?.rows ?? [] : list.rows
        return rows.map { RecordSelection(key: key, id: $0.id) }
    }

    private func selectFirstRecord() {
        guard didRestoreSection, isBrowser else { return }
        model.navigator.selectFirstRecordIfNeeded(visibleRecords, in: model.navigator.section)
    }

    private var sidebar: some View {
        List(
            selection: Binding<SidebarDestination?>(
                get: { model.navigator.macDestination },
                set: { if let value = $0 { model.navigator.macDestination = value } }
            )
        ) {
            ForEach(SidebarManifest.sections) { section in
                if section.label.isEmpty {
                    Section {
                        manifestRows(section)
                        ForEach([AppSection.capture, .photos, .browse, .search]) { native in
                            Label {
                                Text(native.title)
                            } icon: {
                                Image(systemName: native.symbol).foregroundStyle(.secondary)
                            }
                            .tag(SidebarDestination.section(native))
                        }
                    }
                    let workingActivities = model.backgroundActivity.visibleActivities
                    if !workingActivities.isEmpty {
                        Section("Working") {
                            ForEach(workingActivities) { activity in
                                Button {
                                    model.navigator.openActivity(activity.link)
                                } label: {
                                    HStack(spacing: 8) {
                                        if let progress = activity.progress {
                                            ProgressView(value: progress).controlSize(.small)
                                        } else {
                                            ProgressView().controlSize(.small)
                                        }
                                        Text(activity.title)
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint("Opens Activity")
                            }
                        }
                    }
                } else {
                    Section(isExpanded: isExpanded(section)) {
                        manifestRows(section)
                    } header: {
                        HStack(spacing: 6) {
                            if let domain = section.domain {
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(AppDomain(domain).color)
                                    .frame(width: 6, height: 6)
                                    .accessibilityHidden(true)
                            }
                            Text(section.label)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .environment(\.sidebarRowSize, .small)
        .accessibilityIdentifier("sidebar.destinations")
        .navigationSplitViewColumnWidth(min: 160, ideal: 180, max: 240)
    }

    private func isExpanded(_ section: SidebarManifest.Section) -> Binding<Bool> {
        Binding(
            get: {
                if collapsedSectionSet.contains(section.id) { return false }
                if expandedSectionSet.contains(section.id) { return true }
                return !section.defaultFolded
            },
            set: { expanded in
                var collapsed = collapsedSectionSet
                var opened = expandedSectionSet
                if expanded {
                    collapsed.remove(section.id)
                    opened.insert(section.id)
                } else {
                    collapsed.insert(section.id)
                    opened.remove(section.id)
                }
                collapsedDomains = collapsed.sorted().joined(separator: ",")
                expandedSections = opened.sorted().joined(separator: ",")
            }
        )
    }

    private var collapsedSectionSet: Set<String> {
        Set(collapsedDomains.split(separator: ",").map(String.init))
    }

    private var expandedSectionSet: Set<String> {
        Set(expandedSections.split(separator: ",").map(String.init))
    }

    @ViewBuilder private func manifestRows(_ section: SidebarManifest.Section) -> some View {
        ForEach(section.destinations, id: \.route) { destination in
            if let native = destination.nativeDestination {
                sidebarLabel(destination, domain: section.domain)
                    .tag(native)
            } else {
                OpenOnWebButton(target: destination.webTarget) {
                    sidebarLabel(destination, domain: section.domain)
                }
                .buttonStyle(.plain)
                .selectionDisabled()
            }
        }
    }

    private func sidebarLabel(
        _ destination: SidebarManifest.Destination, domain: WayfindingDomain?
    ) -> some View {
        HStack {
            Label {
                Text(destination.label)
            } icon: {
                Image(
                    systemName: destination.entity.map { EntityCatalog[$0].sfSymbol }
                        ?? destination.sfSymbol ?? "link"
                )
                .foregroundStyle(domain.map { AppDomain($0).color } ?? .secondary)
            }
            Spacer(minLength: 4)
            if let entity = destination.entity, let count = model.browseCounts.count(for: entity) {
                NativeCountBadge(count: count)
            }
            if destination.nativeDestination == nil {
                Image(systemName: "arrow.up.right")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder private var browserList: some View {
        if browsing == nil {
            LoadingIndicator.screen(label: "Loading browser")
        } else if model.navigator.section == .search, let browsing {
            SearchView(search: browsing.search)
        } else if let key = model.navigator.browseKey, let browsing {
            EntityListView(key: key, model: browsing.list(for: key), usesBrowseSelection: true).id(key)
        } else {
            BrowseRootView()
        }
    }

    private var recordDetail: some View {
        NavigationStack(path: model.navigator.path(for: model.navigator.section)) {
            Group {
                if model.navigator.section == .activity, let selection = model.navigator.selectedActivity {
                    ActivitySelectionDetailView(selection: selection)
                } else if let record = model.navigator.selectedRecords[model.navigator.section] {
                    RouteDestinationView(route: .entityDetail(record.key, id: record.id))
                        .id(record)
                } else {
                    ContentUnavailableView("Select a record", systemImage: "sidebar.right")
                }
            }
            .navigationDestination(for: Route.self) { RouteDestinationView(route: $0) }
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    RootSplitView()
}

/// In-memory browsing state outlives the split view's changing column content. RootView resets
/// this owner when its client changes, so pages and queries never cross server/session boundaries.
final class NativeBrowserSession {
    let search: SearchModel
    private let client: CubbyClient
    private var lists: [EntityKey: GenericEntityListModel] = [:]

    init(client: CubbyClient) {
        self.client = client
        search = SearchModel(client: client)
    }

    func list(for key: EntityKey) -> GenericEntityListModel {
        if let existing = lists[key] { return existing }
        let descriptor = EntityCatalog[key]
        let model = GenericEntityListModel(
            descriptor: descriptor, client: client,
            filters: descriptor.openingFilters(savedView: nil, explicit: EntityFilterState()),
            view: NativePresentationCoverage.listViews(for: descriptor).first ?? .table)
        lists[key] = model
        return model
    }
}

/// SwiftUI visibility can hide the sidebar or content, but cannot keep sidebar + content while
/// hiding detail. Collapse only the owned root split's items through AppKit for that layout and
/// for sections without a content column; the NavigationSplitView and sidebar retain identity.
private struct SplitColumnCollapse: NSViewRepresentable {
    var contentCollapsed: Bool
    var detailCollapsed: Bool

    func makeNSView(context: Context) -> ColumnProbe { ColumnProbe() }

    func updateNSView(_ view: ColumnProbe, context: Context) {
        view.contentCollapsed = contentCollapsed
        view.detailCollapsed = detailCollapsed
        view.apply()
    }

    final class ColumnProbe: NSView {
        var contentCollapsed = false
        var detailCollapsed = false

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            apply()
        }

        func apply() {
            // SwiftUI attaches/reconciles the hosting hierarchy after updateNSView.
            Task { @MainActor [weak self] in
                guard let self else { return }
                var ancestor = self.superview
                while let view = ancestor {
                    if let split = view as? NSSplitView,
                        let controller = split.delegate as? NSSplitViewController,
                        controller.splitViewItems.count == 3
                    {
                        let content = controller.splitViewItems[1]
                        let detail = controller.splitViewItems[2]
                        content.canCollapse = true
                        detail.canCollapse = true
                        // Expand the destination before collapsing the old column.
                        if !self.contentCollapsed { content.isCollapsed = false }
                        if !self.detailCollapsed { detail.isCollapsed = false }
                        if self.contentCollapsed { content.isCollapsed = true }
                        if self.detailCollapsed { detail.isCollapsed = true }
                        return
                    }
                    ancestor = view.superview
                }
            }
        }
    }
}
