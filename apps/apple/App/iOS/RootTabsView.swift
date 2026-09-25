import CubbyKit
import Photos
import SwiftUI

struct LibraryHomeView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var recentAssets: [PHAsset] = []
    @State private var canReadPhotos = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Library").font(.largeTitle.bold())
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 20) {
                        photosPanel
                        catalogPanel
                    }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 20) {
                            photosPanel.frame(minWidth: 280)
                            catalogPanel.frame(minWidth: 280)
                        }
                        VStack(alignment: .leading, spacing: 20) {
                            photosPanel
                            catalogPanel
                        }
                    }
                }
            }
            .frame(maxWidth: 960, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .top)
            .padding(20)
        }
        .navigationTitle("Library")
        .task { loadRecentAssets() }
    }

    private var photosPanel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                if canReadPhotos && !recentAssets.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: 8) {
                            ForEach(recentAssets, id: \.localIdentifier) { asset in
                                LibraryRecentThumbnail(asset: asset)
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                } else {
                    Text(canReadPhotos ? "No recent photos" : "Open Photos to choose library access")
                        .foregroundStyle(.secondary)
                }
                NavigationLink(value: Route.photosLibrary) {
                    Label("All photos", systemImage: "photo.on.rectangle.angled")
                        .frame(minHeight: PorcelainTokens.touchTarget)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("Photos", systemImage: "photo.on.rectangle.angled")
        }
        .accessibilityIdentifier("library.photos")
    }

    private var catalogPanel: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 14) {
                Text("Browse records by kind, with counts and filters.")
                    .foregroundStyle(.secondary)
                NavigationLink(value: Route.browseCatalog) {
                    Label("Browse catalog", systemImage: "square.grid.2x2")
                        .frame(minHeight: PorcelainTokens.touchTarget)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("Catalog", systemImage: "square.grid.2x2")
        }
        .accessibilityIdentifier("library.catalog")
    }

    private func loadRecentAssets() {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        canReadPhotos = status == .authorized || status == .limited
        guard canReadPhotos else { recentAssets = []; return }
        let options = PHFetchOptions()
        options.fetchLimit = 4
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let result = PHAsset.fetchAssets(with: .image, options: options)
        recentAssets = (0..<result.count).map { result.object(at: $0) }
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
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel(asset.creationDate?.formatted(date: .abbreviated, time: .omitted) ?? "Photo")
        .task(id: asset.localIdentifier) {
            thumbnail = try? await PhotoLibraryIO.shared.thumbnail(for: asset)
        }
    }
}

struct RootTabsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let navigator = model.navigator
        let hasActivity = !model.backgroundActivity.visibleActivities.isEmpty
        TabView(
            selection: Binding(
                get: { navigator.phoneTab },
                set: { navigator.phoneTab = $0 })
        ) {
            ForEach(PhoneTab.allCases) { tab in
                Tab(
                    tab.title, systemImage: tab.symbol, value: tab,
                    role: tab == .find ? .search : nil
                ) {
                    NavigationStack(path: navigator.path(for: tab)) {
                        PhoneTabRootView(tab: tab)
                    }
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
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
