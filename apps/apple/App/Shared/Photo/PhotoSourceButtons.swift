import CubbyKit
import SwiftUI

#if os(iOS)
    import PhotosUI
    import UIKit
#elseif os(macOS)
    import UniformTypeIdentifiers
#endif

/// Shared camera and library selection. Image processing belongs to the caller: Garden keeps
/// scenes intact while product capture can offer subject lifting after selection.
struct PhotoSourceButtons: View {
    let onImages: ([CGImage]) -> Void
    let maxSelectionCount: Int

    init(onImage: @escaping (CGImage) -> Void) {
        maxSelectionCount = 1
        onImages = { images in if let first = images.first { onImage(first) } }
    }

    init(maxSelectionCount: Int, onImages: @escaping ([CGImage]) -> Void) {
        self.maxSelectionCount = maxSelectionCount
        self.onImages = onImages
    }

    #if os(iOS)
        @State private var photoItems: [PhotosPickerItem] = []
        @State private var showingCamera = false
        @State private var failedItems: [PhotosPickerItem] = []
    #elseif os(macOS)
        @State private var showingFileImporter = false
        @State private var failedURLs: [URL] = []
    #endif
    @State private var pickError: String?
    @State private var preparing = false

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) { controls }
                .disabled(preparing)
            if preparing { ProgressView("Preparing photos…") }
            if let pickError {
                Text(pickError)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Retry selection") {
                    #if os(iOS)
                        Task { await loadPicked(failedItems) }
                    #elseif os(macOS)
                        handleFileImport(.success(failedURLs))
                    #endif
                }.disabled(preparing)
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
                allowsMultipleSelection: maxSelectionCount > 1
            ) {
                handleFileImport($0)
            }
        #endif
    }

    @ViewBuilder
    private var controls: some View {
        #if os(iOS)
            PhotosPicker(selection: $photoItems, maxSelectionCount: maxSelectionCount, matching: .images) {
                ActionTile(
                    title: maxSelectionCount == 1 ? "Choose photo" : "Choose photos",
                    symbol: "photo.on.rectangle", detail: "From your library")
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
                ActionTile(
                    title: maxSelectionCount == 1 ? "Choose photo" : "Choose photos",
                    symbol: "photo.on.rectangle", detail: "From files")
            }
            .buttonStyle(.plain)
        #endif
    }

    #if os(iOS)
        private func loadPicked(_ items: [PhotosPickerItem]) async {
            guard !items.isEmpty else { return }
            pickError = nil
            preparing = true
            failedItems = []
            defer { preparing = false }
            var decoded: [CGImage] = []
            for item in items {
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        throw CocoaError(.fileReadCorruptFile)
                    }
                    decoded.append(try CoverImageLoader.decode(data))
                } catch {
                    failedItems.append(item)
                    pickError = error.localizedDescription
                }
            }
            if !decoded.isEmpty { onImages(decoded) }
            photoItems = []
        }
    #elseif os(macOS)
        private func handleFileImport(_ result: Result<[URL], any Error>) {
            pickError = nil
            failedURLs = []
            do {
                let urls = try result.get()
                var images: [CGImage] = []
                for url in urls {
                    let accessing = url.startAccessingSecurityScopedResource()
                    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                    do { images.append(try CoverImageLoader.decode(contentsOf: url)) } catch {
                        failedURLs.append(url); pickError = error.localizedDescription
                    }
                }
                if !images.isEmpty { onImages(images) }
            } catch { pickError = error.localizedDescription }

        }
    #endif
}

#Preview {
    PhotoSourceButtons { _ in }
        .padding()
        .porcelainScreen()
}
