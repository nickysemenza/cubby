import CubbyKit
import SwiftUI

struct RootTabsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var navigator = model.navigator
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
        .safeAreaInset(edge: .top, spacing: 0) {
            if let label = model.localExecutionLabel {
                Button {
                    model.navigator.section = .activity
                } label: {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(label).font(.callout.weight(.medium))
                        Image(systemName: "chevron.right").font(.caption)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(.bar)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens Activity")
            }
        }
        // Today's shortcut tiles move the tab selection; without this they would have nothing to
        // move and would render disabled.
        .environment(\.sectionSelection, $navigator.section)
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    RootTabsView()
}
