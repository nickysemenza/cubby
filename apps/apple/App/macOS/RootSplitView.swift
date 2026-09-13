import CubbyKit
import SwiftUI

struct RootSplitView: View {
    @Environment(AppModel.self) private var model
    /// Which section was showing when the window last closed, restored on relaunch. Keyed by the
    /// window's own scene, like window size (automatic for `WindowGroup`) — a second window would
    /// get its own.
    @SceneStorage("cubby.selectedSection") private var storedSection = AppSection.today.rawValue
    @State private var didRestoreSection = false

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
        .task {
            // Guarded so this only ever fires once per window, and skipped entirely once a deep
            // link has already picked a section — `launchLinkApplied` is set synchronously inside
            // `Navigator.open`, so it reads correctly here whichever of the two fires first: a
            // link that lands before this task runs already flipped the flag (skip restoring over
            // it); a link that lands after still wins, because it's simply the later write to
            // `navigator.section`.
            guard !didRestoreSection else { return }
            didRestoreSection = true
            if !navigator.launchLinkApplied, let restored = AppSection(rawValue: storedSection) {
                navigator.section = restored
            }
        }
        .onChange(of: navigator.section) { _, newValue in
            storedSection = newValue.rawValue
        }
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
