import CubbyKit
import Photos
import SwiftUI

struct LibraryHomeView: View {
    @State private var recentAssets: [PHAsset] = []
    @State private var canReadPhotos = false
    @State private var loadingRecentAssets = true

    var body: some View {
        // The inline navigation title names the screen; no second in-content title.
        List {
            Section("Photos") {
                recentPhotosRow
                NavigationLink(value: Route.photosLibrary) {
                    Label("All photos", systemImage: "photo.on.rectangle.angled")
                }
                .accessibilityIdentifier("library.photos")
            }
            Section {
                NavigationLink(value: Route.browseCatalog) {
                    Label("Browse catalog", systemImage: "square.grid.2x2")
                }
                .accessibilityIdentifier("library.catalog")
            } header: {
                Text("Catalog")
            } footer: {
                Text("Browse records by kind, with counts and filters.")
            }
        }
        .navigationTitle("Library")
        .task { await loadRecentAssets() }
    }

    /// The recent-photo strip is media, not a grouped cell, so it sits on a clear row.
    @ViewBuilder private var recentPhotosRow: some View {
        Group {
            if loadingRecentAssets {
                LoadingIndicator(label: "Loading recent photos")
                    .frame(maxWidth: .infinity, minHeight: 112)
            } else if canReadPhotos && !recentAssets.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: FieldGuideTokens.Space.sm) {
                        ForEach(recentAssets, id: \.localIdentifier) { asset in
                            LibraryRecentThumbnail(asset: asset)
                        }
                    }
                }
                .contentMargins(.horizontal, FieldGuideTokens.Space.lg, for: .scrollContent)
                .scrollIndicators(.hidden)
            } else {
                Text(canReadPhotos ? "No recent photos" : "Open Photos to choose library access")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, FieldGuideTokens.Space.lg)
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    private func loadRecentAssets() async {
        loadingRecentAssets = true
        let assets = await PhotoLibraryIO.shared.recentImages(limit: 4)
        guard !Task.isCancelled else { return }
        canReadPhotos = assets != nil
        recentAssets = assets ?? []
        loadingRecentAssets = false
    }
}

private struct LibraryRecentThumbnail: View {
    let asset: PHAsset
    @State private var thumbnail: CGImage?

    var body: some View {
        Group {
            if let thumbnail {
                Image(decorative: thumbnail, scale: 1).resizable().scaledToFill()
            } else {
                Rectangle().fill(.quaternary).overlay { Image(systemName: "photo") }
            }
        }
        .frame(width: 112, height: 112)
        .clipShape(RoundedRectangle(cornerRadius: FieldGuideTokens.radiusPanel))
        .accessibilityLabel(asset.creationDate.map { DatePresentation.timestamp($0).absolute } ?? "Photo")
        .task(id: asset.localIdentifier) {
            thumbnail = try? await PhotoLibraryIO.shared.thumbnail(for: asset)
        }
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
                set: { navigator.phoneTab = $0 })
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

#Preview("Library") {
    NavigationStack { LibraryHomeView() }
}
