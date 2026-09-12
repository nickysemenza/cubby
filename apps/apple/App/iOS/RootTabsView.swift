import CubbyKit
import SwiftUI

struct RootTabsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var navigator = model.navigator
        TabView(selection: $navigator.section) {
            ForEach(AppSection.allCases) { section in
                Tab(section.title, systemImage: section.symbol, value: section) {
                    NavigationStack(path: navigator.path(for: section)) {
                        SectionView(section: section)
                    }
                }
            }
        }
        // Today's shortcut tiles move the tab selection; without this they would have nothing to
        // move and would render disabled.
        .environment(\.sectionSelection, $navigator.section)
    }
}

#Preview {
    RootTabsView().environment(PreviewFixtures.signedInModel())
}
