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
            case .capture: CaptureView()
            case .photos: PhotosRootView()
            case .browse: BrowseRootView()
            case .search: SearchView()
            case .dev: DevView()
            }
        }
        #if os(iOS)
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
            RouteDestinationView(route: route)
        }
    }
}

/// Sheet-owned stacks need destinations for links followed from image associations too.
struct RouteDestinationView: View {
    let route: Route
    var body: some View {
        switch route {
        case .garden: GardenRootView()
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
