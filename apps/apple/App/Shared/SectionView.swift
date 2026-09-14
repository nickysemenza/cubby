import CubbyKit
import SwiftUI

/// Routes a top-level section to its screen and owns the shared `Route` destinations, so the
/// iOS tab stacks and the macOS detail column resolve pushes identically.
///
/// Also opens the one `Namespace` a section's list and search rows share with its entity detail
/// destination, for the iOS 18+ zoom transition (`EntityRowView`/`SearchHitRow`'s thumbnails are
/// the `.matchedTransitionSource`s; `zoomSource(id:in:)` reads it back out of the environment).
/// It lives here, not lower in the tree, because `.navigationDestination` and the rows that push
/// into it are siblings under this view, not ancestor/descendant of each other — an environment
/// value set any lower would never reach the destination closure below.
struct SectionView: View {
    let section: AppSection

    #if os(iOS)
        @Namespace private var zoomNamespace
    #endif

    var body: some View {
        Group {
            switch section {
            case .today: TodayView()
            case .capture: CaptureView()
            case .photos: PhotosRootView()
            case .browse: BrowseRootView()
            case .search: SearchView()
            case .dev: DevView()
            }
        }
        #if os(iOS)
            .environment(\.zoomNamespace, zoomNamespace)
            // The tab bar renders only a title and an image, so the mark the macOS sidebar shows
            // beside each row lives in the section root's navigation bar here. Pushed routes have
            // their own toolbars and do not inherit it.
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SectionDomainMarks(section: section)
                }
                .sharedBackgroundVisibility(.hidden)
            }
        #endif
        .navigationDestination(for: Route.self) { route in
            #if os(iOS)
                if case .entityDetail(_, let id) = route {
                    RouteDestinationView(route: route)
                        .navigationTransition(.zoom(sourceID: id, in: zoomNamespace))
                } else {
                    RouteDestinationView(route: route)
                }
            #else
                RouteDestinationView(route: route)
            #endif
        }
    }
}

/// Sheet-owned stacks need destinations for links followed from image associations too.
struct RouteDestinationView: View {
    let route: Route
    var body: some View {
        switch route {
        case .entityDetail(.planting, let id): GardenPlantingRouteView(id: id)
        case .entityDetail(.gardenEntry, let id): GardenEntryRouteView(id: id)
        case .entityDetail(.image, let id): ImageEntityDetailView(id: ImageCode(id))
        case .entityDetail(let key, let id): EntityDetailView(key: key, id: id)
        case .entityList(let key): EntityListView(key: key)
        case .gardenBedJournal(let id): GardenBedJournalView(locationID: id)
        case .audit(let id): AuditRootView(locationID: id)
        case .needsPhoto(let id): NeedsPhotoView(locationID: id)
        case .identify: IdentifyView()
        case .dev: DevView()
        }
    }
}

#Preview {
    NavigationStack {
        SectionView(section: .capture)
    }
    .environment(PreviewFixtures.signedInModel())
}
