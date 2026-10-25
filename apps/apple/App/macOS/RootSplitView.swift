import CubbyKit
import SwiftUI

struct RootSplitView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @SceneStorage("cubby.selectedSection") private var storedSection = AppSection.today.rawValue
    /// Manifest section ids; retain existing domain preferences across windows and launches.
    @AppStorage("cubby.sidebar.collapsedDomains") private var collapsedDomains = ""
    @AppStorage("cubby.sidebar.expandedSections") private var expandedSections = ""
    @State private var didRestoreSection = false
    @State private var browsing: NativeBrowserSession?

    private var isBrowser: Bool {
        model.navigator.section == .search || model.navigator.section == .browse
    }

    var body: some View {
        Group {
            if isBrowser {
                NavigationSplitView {
                    sidebar
                } content: {
                    browserList
                        .navigationSplitViewColumnWidth(min: 260, ideal: 420, max: 760)
                } detail: {
                    recordDetail
                }
            } else {
                NavigationSplitView {
                    sidebar
                } detail: {
                    NavigationStack(path: model.navigator.path(for: model.navigator.section)) {
                        SectionView(section: model.navigator.section)
                    }
                }
            }
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
            if !model.navigator.launchLinkApplied, let section = AppSection(rawValue: storedSection) {
                model.navigator.section = section
            }
        }
        .onChange(of: model.navigator.section) { _, value in storedSection = value.rawValue }
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
                    Section {
                        Label(AppSection.settings.title, systemImage: AppSection.settings.symbol)
                            .tag(SidebarDestination.section(.settings))
                            .accessibilityIdentifier("sidebar.settings")
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
                Button {
                    if let url = destination.webURL(serverURL: model.client.baseURL) {
                        openURL(url)
                    }
                } label: {
                    sidebarLabel(destination, domain: section.domain)
                }
                .buttonStyle(.plain)
                .selectionDisabled()
                .accessibilityHint("Opens in the default browser")
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
                if let record = model.navigator.selectedRecords[model.navigator.section] {
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
