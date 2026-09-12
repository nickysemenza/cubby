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

/// A sidebar row carries the domain line it works in: Capture and Identify both act on House
/// records, and Browse previews all four lines because it contains all of them. Today and Dev are
/// the shell itself and get no mark.
private struct SidebarRow: View {
    let section: AppSection

    var body: some View {
        HStack(spacing: PorcelainTokens.Space.sm) {
            Image(systemName: section.symbol)
                .foregroundStyle(PorcelainTokens.graphiteSecondary)
                .frame(width: 18)
            Text(section.title).font(.porcelainBody)
            Spacer(minLength: PorcelainTokens.Space.sm)
            marks
        }
        .frame(minHeight: 28)
    }

    @ViewBuilder
    private var marks: some View {
        switch section {
        case .capture, .identify:
            DomainMark(.house, size: 7)
        case .browse:
            HStack(spacing: 3) {
                ForEach(AppDomain.allCases) { domain in
                    DomainMark(domain, size: 5)
                }
            }
        case .today, .dev:
            EmptyView()
        }
    }
}

#Preview {
    RootSplitView().environment(PreviewFixtures.signedInModel())
}
