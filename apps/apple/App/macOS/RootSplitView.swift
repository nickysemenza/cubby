import CubbyKit
import SwiftUI

struct RootSplitView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var navigator = model.navigator
        // The sidebar's selection is optional because a `NavigationSplitView` can have nothing
        // selected; the navigator's is not, so a cleared sidebar falls back to Today.
        let selection = Binding<AppSection?>(
            get: { navigator.section },
            set: { navigator.section = $0 ?? .today }
        )
        NavigationSplitView {
            // Explicit tags: a List over Identifiable rows selects by `id` (a String), which
            // would never match an `AppSection?` binding and leaves the sidebar unclickable.
            List(selection: selection) {
                ForEach(AppSection.allCases) { section in
                    SidebarRow(section: section).tag(section)
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 208)
        } detail: {
            NavigationStack(path: navigator.path(for: navigator.section)) {
                SectionView(section: navigator.section)
            }
        }
        .environment(\.sectionSelection, $navigator.section)
        .frame(minWidth: 720, minHeight: 480)
    }
}

/// A sidebar row carries the domain line it works in; see `SectionDomainMarks`.
private struct SidebarRow: View {
    let section: AppSection

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.sm) {
            Image(systemName: section.symbol)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                .frame(width: 18)
            Text(section.title).font(.porcelainBody)
            Spacer(minLength: PorcelainTokens.Space.sm)
            SectionDomainMarks(section: section)
        }
        .frame(minHeight: 28)
    }
}

#Preview {
    RootSplitView().environment(PreviewFixtures.signedInModel())
}
