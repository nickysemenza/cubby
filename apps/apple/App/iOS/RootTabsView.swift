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
    }
}

#Preview {
    RootTabsView().environment(PreviewFixtures.signedInModel())
}
