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
            case .browse: BrowseRootView()
            case .identify: IdentifyView()
            case .dev: DevView()
            }
        }
        .navigationDestination(for: Route.self) { route in
            switch route {
            case .entityList(let key): EntityListView(key: key)
            case .entityDetail(let key, let id):
                switch key {
                case .planting: GardenPlantingRouteView(id: id)
                case .gardenEntry: GardenEntryRouteView(id: id)
                default: EntityDetailView(key: key, id: id)
                }
            case .gardenBedJournal(let id): GardenBedJournalView(locationID: id)
            case .audit(let locationID): AuditRootView(locationID: locationID)
            case .needsPhoto(let locationID): NeedsPhotoView(locationID: locationID)
            }
        }
    }
}
