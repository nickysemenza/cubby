import CubbyKit
import SwiftUI

struct RootTabsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var navigator = model.navigator
        let hasActivity = !model.backgroundActivity.visibleActivities.isEmpty
        TabView(selection: $navigator.section) {
            ForEach(AppSection.tabs) { section in
                // The search role pulls the tab out of the bar into its own pill (iOS 26) and
                // hands its field to the section's `.searchable`.
                Tab(
                    section.title, systemImage: section.symbol, value: section,
                    role: section == .search ? .search : nil
                ) {
                    NavigationStack(path: navigator.path(for: section)) {
                        SectionView(section: section)
                    }
                }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .backgroundActivityAccessory(isEnabled: hasActivity)
        // Today's shortcut tiles move the tab selection; without this they would have nothing to
        // move and would render disabled.
        .environment(\.sectionSelection, $navigator.section)
    }
}

extension View {
    /// `.tabViewBottomAccessory(isEnabled:content:)` (dynamic show/hide, reserving no space while
    /// hidden) only exists on iOS 26.1+; the deployment target stays iOS 26.0, so below 26.1 the
    /// accessory is always attached and its own content decides whether to render anything —
    /// leaving an empty reserved strip is the accepted trade-off on that one OS point release.
    @ViewBuilder
    fileprivate func backgroundActivityAccessory(isEnabled: Bool) -> some View {
        if #available(iOS 26.1, *) {
            self.tabViewBottomAccessory(isEnabled: isEnabled) { BackgroundActivityBar() }
        } else {
            self.tabViewBottomAccessory {
                if isEnabled { BackgroundActivityBar() }
            }
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    RootTabsView()
}
