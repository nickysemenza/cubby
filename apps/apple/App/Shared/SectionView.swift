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
            switch route {
            case .entityList(let key): EntityListView(key: key)
            case .entityDetail(let key, let id): EntityDetailView(key: key, id: id)
            case .audit(let locationID): AuditRootView(locationID: locationID)
            case .needsPhoto(let locationID): NeedsPhotoView(locationID: locationID)
            }
        }
    }
}
