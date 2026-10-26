import CubbyKit
import SwiftUI

struct LibraryHomeView: View {
    var body: some View {
        BrowseRootView(title: "Library")
    }
}

struct RootTabsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        let navigator = model.navigator
        let hasActivity = !model.backgroundActivity.visibleActivities.isEmpty
        TabView(
            selection: Binding(
                get: { navigator.phoneTab },
                set: { tab in
                    if tab == .work, navigator.phoneTab == .work {
                        navigator.paths[.today] = []
                    }
                    navigator.phoneTab = tab
                })
        ) {
            ForEach(PhoneTab.primary) { tab in
                Tab(
                    tab.title, systemImage: tab.symbol, value: tab,
                    role: tab == .find ? .search : nil
                ) {
                    NavigationStack(path: navigator.path(for: tab)) {
                        PhoneTabRootView(tab: tab)
                    }
                }
            }
            Tab("Settings", systemImage: PhoneTab.settings.symbol, value: PhoneTab.settings) {
                NavigationStack(path: navigator.path(for: PhoneTab.settings)) {
                    PhoneTabRootView(tab: .settings)
                }
            }
            .tabPlacement(.sidebarOnly)
            .hidden(horizontalSizeClass == .compact)
        }
        .tabViewStyle(.sidebarAdaptable)
        .onChange(of: horizontalSizeClass, initial: true) { _, sizeClass in
            if sizeClass == .compact { navigator.adaptSettingsToCompactNavigation() }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .backgroundActivityAccessory(isEnabled: hasActivity)
        // Today's shortcut tiles move the tab selection; without this they would have nothing to
        // move and would render disabled.
        .environment(
            \.sectionSelection,
            Binding(get: { navigator.section }, set: { navigator.section = $0 }))
    }
}

extension View {
    fileprivate func backgroundActivityAccessory(isEnabled: Bool) -> some View {
        self.tabViewBottomAccessory(isEnabled: isEnabled) { BackgroundActivityBar() }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    RootTabsView()
}

#Preview("Library", traits: .modifier(SignedInPreview())) {
    NavigationStack { LibraryHomeView() }
}
