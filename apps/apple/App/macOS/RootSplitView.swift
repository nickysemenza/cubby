import CubbyKit
import SwiftUI

struct RootSplitView: View {
    @Environment(AppModel.self) private var model
    @SceneStorage("cubby.selectedSection") private var storedSection = AppSection.today.rawValue
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
            Section("Cubby") {
                ForEach(AppSection.tabs.filter { $0 != .dev }) { section in
                    Label(section.title, systemImage: section.symbol)
                        .tag(SidebarDestination.section(section))
                }
            }
            ForEach(AppDomain.allCases) { domain in
                Section(domain.title) {
                    ForEach(
                        EntityCatalog.all.filter {
                            $0.key.domain == domain && $0.key.nativeActions.contains(.list)
                        }.sorted { $0.plural < $1.plural }, id: \.key
                    ) { descriptor in
                        Label(descriptor.plural, systemImage: descriptor.sfSymbol)
                            .tag(SidebarDestination.entity(descriptor.key))
                    }
                }
            }
            let media = EntityCatalog.all.filter {
                $0.domain == nil && $0.key.nativeActions.contains(.list)
            }.sorted { $0.plural < $1.plural }
            if !media.isEmpty {
                Section("Media") {
                    ForEach(media, id: \.key) { descriptor in
                        Label(descriptor.plural, systemImage: descriptor.sfSymbol)
                            .tag(SidebarDestination.entity(descriptor.key))
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .accessibilityIdentifier("sidebar.destinations")
        .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
    }

    @ViewBuilder private var browserList: some View {
        if browsing == nil {
            LoadingIndicator.screen(label: "Loading browser")
        } else if model.navigator.section == .search, let browsing {
            SearchView(search: browsing.search)
        } else if let key = model.navigator.browseKey, let browsing {
            EntityListView(key: key, model: browsing.list(for: key)).id(key)
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
private final class NativeBrowserSession {
    let search: SearchModel
    private let client: CubbyClient
    private var lists: [EntityKey: GenericEntityListModel] = [:]

    init(client: CubbyClient) {
        self.client = client
        search = SearchModel(client: client)
    }

    func list(for key: EntityKey) -> GenericEntityListModel {
        if let existing = lists[key] { return existing }
        let model = GenericEntityListModel(descriptor: EntityCatalog[key], client: client)
        lists[key] = model
        return model
    }
}
