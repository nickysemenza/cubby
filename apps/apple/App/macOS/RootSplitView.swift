import CubbyKit
import SwiftUI

struct RootSplitView: View {
    @State private var selection: AppSection? = .today

    /// Today's shortcuts want a non-optional selection; the sidebar's is optional because a
    /// `NavigationSplitView` can have nothing selected.
    private var sectionBinding: Binding<AppSection> {
        Binding(get: { selection ?? .today }, set: { selection = $0 })
    }

    var body: some View {
        NavigationSplitView {
            // Explicit tags: a List over Identifiable rows selects by `id` (a String), which
            // would never match an `AppSection?` binding and leaves the sidebar unclickable.
            List(selection: $selection) {
                ForEach(AppSection.allCases) { section in
                    SidebarRow(section: section).tag(section)
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 208)
        } detail: {
            NavigationStack {
                SectionView(section: selection ?? .today)
            }
        }
        .environment(\.sectionSelection, sectionBinding)
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
