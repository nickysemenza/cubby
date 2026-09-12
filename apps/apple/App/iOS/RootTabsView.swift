import CubbyKit
import SwiftUI

struct RootTabsView: View {
    @State private var selection: AppSection = .today

    var body: some View {
        TabView(selection: $selection) {
            ForEach(AppSection.allCases) { section in
                Tab(section.title, systemImage: section.symbol, value: section) {
                    NavigationStack {
                        SectionView(section: section)
                    }
                }
            }
        }
        // Today's shortcut tiles move the tab selection; without this they would have nothing to
        // move and would render disabled.
        .environment(\.sectionSelection, $selection)
    }
}

#Preview {
    RootTabsView().environment(PreviewFixtures.signedInModel())
}
