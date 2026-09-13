import CubbyKit
import SwiftUI

#if os(iOS)
    import PhotosUI
    import UIKit
#elseif os(macOS)
    import UniformTypeIdentifiers
#endif

/// Full-scene garden photo selection. This intentionally bypasses subject lifting: a bed overview
/// is useful precisely because it includes several plants and their surroundings.
struct GardenPhotoSourceButtons: View {
    let onImages: ([CGImage]) -> Void

    #if os(iOS)
        @State private var photoItems: [PhotosPickerItem] = []
        @State private var showingCamera = false
    #elseif os(macOS)
        @State private var showingFileImporter = false
    #endif
    @State private var pickError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) { controls }
            if let pickError {
                Text(pickError)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        #if os(iOS)
            .onChange(of: photoItems) { _, items in Task { await loadPicked(items) } }
            .fullScreenCover(isPresented: $showingCamera) {
                CameraPicker { onImages([$0]) }
                .ignoresSafeArea()
            }
        #elseif os(macOS)
            .fileImporter(
                isPresented: $showingFileImporter, allowedContentTypes: [.image],
                allowsMultipleSelection: true
            ) {
                handleFileImport($0)
            }
        #endif
    }

    @ViewBuilder
    private var controls: some View {
        #if os(iOS)
            PhotosPicker(selection: $photoItems, maxSelectionCount: 12, matching: .images) {
                ActionTile(title: "Choose photos", symbol: "photo.on.rectangle", detail: "From your library")
            }
            .buttonStyle(.plain)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    showingCamera = true
                } label: {
                    ActionTile(title: "Take photo", symbol: "camera", detail: "Use the camera")
                }
                .buttonStyle(.plain)
            }
        #elseif os(macOS)
            Button {
                showingFileImporter = true
            } label: {
                ActionTile(title: "Choose photos", symbol: "photo.on.rectangle", detail: "From files")
            }
            .buttonStyle(.plain)
        #endif
    }

    #if os(iOS)
        private func loadPicked(_ items: [PhotosPickerItem]) async {
            guard !items.isEmpty else { return }
            pickError = nil
            do {
                var decoded: [CGImage] = []
                for item in items {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        throw CocoaError(.fileReadCorruptFile)
                    }
                    decoded.append(try CoverImageLoader.decode(data))
                }
                onImages(decoded)
            } catch {
                pickError = String(describing: error)
            }
            photoItems = []
        }
    #elseif os(macOS)
        private func handleFileImport(_ result: Result<[URL], any Error>) {
            pickError = nil
            do {
                let urls = try result.get()
                let images = try urls.map { url -> CGImage in
                    let accessing = url.startAccessingSecurityScopedResource()
                    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                    return try CoverImageLoader.decode(contentsOf: url)
                }
                onImages(images)
            } catch {
                pickError = String(describing: error)
            }
        }
    #endif
}

#Preview {
    GardenPhotoSourceButtons { _ in }
        .padding()
        .porcelainScreen()
}
