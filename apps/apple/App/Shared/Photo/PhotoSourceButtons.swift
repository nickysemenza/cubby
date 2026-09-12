import CubbyKit
import SwiftUI

#if os(iOS)
    import PhotosUI
    import UIKit
#elseif os(macOS)
    import UniformTypeIdentifiers
#endif

/// The two (iOS) or one (macOS) ways to get a picture into the app, as a grid of tiles. Decodes
/// what was picked into a `CGImage` and reports it; shows its own decode error underneath.
struct PhotoSourceButtons: View {
    let onImage: (CGImage) -> Void

    #if os(iOS)
        @State private var photoItem: PhotosPickerItem?
        @State private var showingCamera = false
    #elseif os(macOS)
        @State private var showingFileImporter = false
    #endif
    @State private var pickError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) {
                controls
            }
            if let pickError {
                Text(pickError)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.destructive)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        #if os(iOS)
            .onChange(of: photoItem) { _, newItem in
                Task { await loadPicked(newItem) }
            }
            .fullScreenCover(isPresented: $showingCamera) {
                CameraPicker(onCapture: onImage)
                .ignoresSafeArea()
            }
        #elseif os(macOS)
            .fileImporter(isPresented: $showingFileImporter, allowedContentTypes: [.image]) { result in
                handleFileImport(result)
            }
        #endif
    }

    @ViewBuilder
    private var controls: some View {
        #if os(iOS)
            PhotosPicker(selection: $photoItem, matching: .images) {
                ActionTile(title: "Choose photo", symbol: "photo.on.rectangle", detail: "From your library")
            }
            .buttonStyle(.plain)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    showingCamera = true
                } label: {
                    ActionTile(title: "Take photo", symbol: "camera", detail: "Use the camera")
                }
                .buttonStyle(.plain)
            } else {
                ActionTile(title: "Take photo", symbol: "camera", detail: "No camera here")
                    .opacity(0.5)
            }
        #elseif os(macOS)
            Button {
                showingFileImporter = true
            } label: {
                ActionTile(title: "Choose image…", symbol: "photo.on.rectangle", detail: "From a file")
            }
            .buttonStyle(.plain)
        #endif
    }

    #if os(iOS)
        private func loadPicked(_ item: PhotosPickerItem?) async {
            guard let item else { return }
            pickError = nil
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { return }
                onImage(try CoverImageLoader.decode(data))
            } catch {
                pickError = String(describing: error)
            }
            photoItem = nil
        }
    #elseif os(macOS)
        private func handleFileImport(_ result: Result<URL, any Error>) {
            pickError = nil
            switch result {
            case .success(let url):
                let accessing = url.startAccessingSecurityScopedResource()
                defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                do {
                    onImage(try CoverImageLoader.decode(contentsOf: url))
                } catch {
                    pickError = String(describing: error)
                }
            case .failure(let error):
                pickError = String(describing: error)
            }
        }
    #endif
}

#Preview {
    PhotoSourceButtons { _ in }
        .padding()
        .porcelainScreen()
}
