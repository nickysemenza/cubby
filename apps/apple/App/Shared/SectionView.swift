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
            case .entityDetail(let key, let id): EntityDetailView(key: key, id: id)
            }
        }
    }
}

struct TodayView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        List {
            Section {
                LabeledContent("Server", value: model.host)
                LabeledContent("Signed in", value: model.phase == .signedIn ? "Yes" : "No")
            } footer: {
                Text("Today is a placeholder in the PoC. Tasks, meals, problems, and expiring pantry land here next.")
            }
        }
        .navigationTitle("Today")
    }
}

#Preview {
    NavigationStack { TodayView() }.environment(PreviewFixtures.signedInModel())
}
