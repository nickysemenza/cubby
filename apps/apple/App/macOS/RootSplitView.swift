import CubbyKit
import SwiftUI

struct RootSplitView: View {
    @State private var selection: AppSection? = .today

    var body: some View {
        NavigationSplitView {
            // Explicit tags: a List over Identifiable rows selects by `id` (a String), which
            // would never match an `AppSection?` binding and leaves the sidebar unclickable.
            List(selection: $selection) {
                ForEach(AppSection.allCases) { section in
                    Label(section.title, systemImage: section.symbol).tag(section)
                }
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180)
        } detail: {
            NavigationStack {
                SectionView(section: selection ?? .today)
            }
        }
        .frame(minWidth: 720, minHeight: 480)
    }
}

#Preview {
    RootSplitView().environment(PreviewFixtures.signedInModel())
}
