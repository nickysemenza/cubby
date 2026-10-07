import CubbyKit
import SwiftUI

/// Routes a top-level section to its screen and owns the shared `Route` destinations, so the
/// iOS tab stacks and the macOS detail column resolve pushes identically.
struct SectionView: View {
    let section: AppSection

    var body: some View {
        Group {
            switch section {
            case .today: TodayView()
            case .activity: ActivityView()
            #if os(macOS)
                case .browserSync: BrowserSyncPane()
            #endif
            case .capture: CaptureView()
            case .photos: PhotosRootView()
            case .browse: BrowseRootView()
            case .search: SearchView()
            case .dev: DevView()
            case .settings: SettingsView(isSidebarRoot: true)
            case .graph: GraphWorkspaceView()
            }
        }
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .navigationDestination(for: Route.self) { route in
            RouteDestinationView(route: route)
        }
    }
}

/// iOS destinations stay stable even while a nested Activity or Photos screen is visible.
#if os(iOS)
    struct PhoneTabRootView: View {
        let tab: PhoneTab

        var body: some View {
            Group {
                switch tab {
                case .work: WorkRootView()
                case .capture: CaptureView()
                case .library: LibraryHomeView()
                case .find: SearchView()
                case .settings: SettingsView(isSidebarRoot: true)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Route.self) { RouteDestinationView(route: $0) }
        }
    }
#endif

/// Sheet-owned stacks need destinations for links followed from image associations too.
struct RouteDestinationView: View {
    let route: Route
    var body: some View {
        switch route {
        case .activityList: ActivityView()
        case .auditHistory: AuditHistoryView()
        case .photosLibrary: PhotosRootView()
        case .browseCatalog: BrowseRootView()
        case .statementCsvImport: StatementCsvImportView()
        case .graph(let root): GraphWorkspaceView(initialRoot: root)
        case .nutrition(let day): DailyNutritionView(day: day)
        case .activityDetail(let id): ActivityDetailView(id: id)
        case .localActivity(let id): LocalActivityDetailView(id: id)
        case .entityDetail(.image, let id): ImageEntityDetailView(id: ImageCode(id))
        case .entityDetail(.run, let id): RunConsoleView(runID: id).id(id)
        // Keyed by record: a deep link opened over a visible detail reuses this view's
        // identity, and its model/sections are bound to the first record's descriptor.
        case .entityDetail(let key, let id):
            EntityDetailView(key: key, id: id).id("\(key.rawValue)/\(id)")
        case .wardrobe(let ownerID, let ownerName):
            WardrobeView(ownerID: ownerID, ownerName: ownerName)
        case .entityList(let key, let filters): EntityListView(key: key, filters: filters)
        case .audit(let id): AuditRootView(locationID: id)
        case .needsPhoto(let id): NeedsPhotoView(locationID: id)
        case .locationPhotoPass(let scope): LocationPhotoPassView(scope: scope)
        case .identify: IdentifyView()
        case .dev: DevView()
        case .settings: SettingsView()
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    NavigationStack {
        SectionView(section: .capture)
    }
}
