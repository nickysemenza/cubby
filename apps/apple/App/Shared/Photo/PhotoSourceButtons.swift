import CoreGraphics
import CubbyKit
import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
    import Photos
    import PhotosUI
    import UIKit
#elseif os(macOS)
    import UniformTypeIdentifiers
#endif

/// Shared camera and library selection. Sources retain their original bytes; only the bounded
/// 256px preview is decoded for the UI. Callers decide whether to upload, match, or attach them.
struct PhotoSourceButtons: View {
    let onSelection: ([PhotoSelectionItem]) -> Void
    let maxSelectionCount: Int
    let reviewsUploads: Bool
    @Environment(AppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var matchingSession = UUID()
    @State private var showingLibrary = false
    @State private var review: PhotoMatchReviewBatch?

    init(onImage: @escaping (CGImage) -> Void) {
        maxSelectionCount = 1
        reviewsUploads = false
        onSelection = { selections in
            if let first = selections.first { onImage(first.preview) }
        }
    }

    init(
        maxSelectionCount: Int, reviewsUploads: Bool = true,
        onSelection: @escaping ([PhotoSelectionItem]) -> Void
    ) {
        self.reviewsUploads = reviewsUploads
        self.maxSelectionCount = maxSelectionCount
        self.onSelection = onSelection
    }

    #if os(iOS) || os(macOS)
        @State private var photoItems: [PhotosPickerItem] = []
        @State private var pendingPickedItems: [PhotosPickerItem] = []
    #endif
    #if os(iOS)
        @State private var showingCamera = false
    #elseif os(macOS)
        @State private var showingFileImporter = false
        @State private var failedURLs: [URL] = []
        @State private var fileImportActive = false
    #endif
    @State private var pickError: String?
    @State private var preparing = false
    @State private var preparationProgress = 0.0
    @State private var pendingSelections: [PhotoSelectionItem?] = []
    @State private var failedIndexes: [Int] = []
    @State private var preparationTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: PorcelainTokens.Space.sm) {
            LazyVGrid(columns: porcelainTwoColumns, spacing: PorcelainTokens.Space.md) { controls }
                .disabled(preparing)
            if preparing { ProgressView("Preparing photos…", value: preparationProgress, total: 1) }
            if let pickError {
                Text(pickError)
                    .font(.porcelainLabel)
                    .foregroundStyle(PorcelainTokens.destructive)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Retry failed photos") {
                    #if os(iOS)
                        preparationTask = Task { await retryPicked() }
                    #elseif os(macOS)
                        if fileImportActive {
                            handleFileImport(.success(failedURLs), retrying: true)
                        } else {
                            preparationTask = Task { await retryPicked() }
                        }
                    #endif
                }.disabled(preparing)
                Button("Continue without failed photos") { finishPending(skipFailed: true) }
                    .disabled(preparing || pendingSelections.compactMap { $0 }.isEmpty)
            }
        }
        .sheet(isPresented: $showingLibrary) {
            LibraryPickerSheet(maxSelectionCount: maxSelectionCount) { selections in
                Task { @MainActor in
                    await Task.yield()
                    deliver(selections)
                }
            }
            .nativeSheet(.picker)
        }
        .sheet(item: $review) { batch in
            PhotoMatchReviewSheet(draft: batch.draft, onContinue: onSelection)
        }
        #if os(iOS) || os(macOS)
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                preparationTask?.cancel()
                preparationTask = Task { await loadPicked(items) }
            }
        #endif
        #if os(iOS)
            .fullScreenCover(isPresented: $showingCamera) {
                CameraPicker { data in Task { await receiveCameraData(data) } }
                .ignoresSafeArea()
            }
        #elseif os(macOS)
            .fileImporter(
                isPresented: $showingFileImporter, allowedContentTypes: [.image],
                allowsMultipleSelection: maxSelectionCount > 1
            ) { handleFileImport($0) }
        #endif
        .task {
            if reviewsUploads {
                appModel.photoMatches.acquire(matchingSession)
                await appModel.photoMatches.refresh(client: appModel.client)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && reviewsUploads {
                Task { await appModel.photoMatches.refresh(client: appModel.client) }
            }
        }
        .onDisappear {
            if reviewsUploads { appModel.photoMatches.release(matchingSession) }
            preparationTask?.cancel()
            preparationTask = nil
        }
    }

    @ViewBuilder
    private var controls: some View {
        if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized {
            Button {
                showingLibrary = true
            } label: {
                ActionTile(
                    title: "Browse Photos", symbol: "photo.on.rectangle.angled",
                    detail: "See what is in Cubby")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("photo.source.browseLibrary")
        }
        #if os(iOS) || os(macOS)
            PhotosPicker(
                selection: $photoItems, maxSelectionCount: maxSelectionCount, selectionBehavior: .ordered,
                matching: .images, preferredItemEncoding: .current
            ) {
                ActionTile(
                    title: maxSelectionCount == 1 ? "Choose photo" : "Choose photos",
                    symbol: "photo.on.rectangle", detail: "From your library")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("photo.source.systemPicker")
            #if os(iOS)
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button {
                        showingCamera = true
                    } label: {
                        ActionTile(title: "Take photo", symbol: "camera", detail: "Use the camera")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("photo.source.camera")
                }
            #endif
        #endif
        #if os(macOS)
            Button {
                showingFileImporter = true
            } label: {
                ActionTile(
                    title: maxSelectionCount == 1 ? "Choose photo" : "Choose photos",
                    symbol: "photo.on.rectangle", detail: "From files")
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("photo.source.files")
        #endif
    }

    private func deliver(_ selections: [PhotoSelectionItem]) {
        // The draft is built here, once per batch, and owned by the batch rather than seeded
        // into the sheet's own @State — see `PhotoMatchReviewBatch`'s doc comment.
        if reviewsUploads {
            review = PhotoMatchReviewBatch(items: selections, draft: PhotoReviewDraft(items: selections))
        } else {
            onSelection(selections)
        }
    }

    private func finishPending(skipFailed: Bool) {
        guard skipFailed || failedIndexes.isEmpty else { return }
        let selections = pendingSelections.compactMap { $0 }
        guard !selections.isEmpty else { return }
        pendingSelections = []
        failedIndexes = []
        pickError = nil
        #if os(macOS)
            fileImportActive = false
        #endif
        deliver(selections)
    }

    #if os(iOS) || os(macOS)
        private func loadPicked(_ items: [PhotosPickerItem]) async {
            guard !items.isEmpty else { return }
            pickError = nil
            preparing = true
            #if os(macOS)
                fileImportActive = false
            #endif
            preparationProgress = 0
            pendingPickedItems = items
            pendingSelections = Array(repeating: nil, count: items.count)
            failedIndexes = []
            defer {
                preparing = false
                photoItems = []
            }
            for (index, item) in items.enumerated() {
                do {
                    pendingSelections[index] = try await selection(for: item) { [self] fraction in
                        Task { @MainActor in
                            preparationProgress = (Double(index) + fraction) / Double(items.count)
                        }
                    }
                    preparationProgress = Double(index + 1) / Double(items.count)
                } catch is CancellationError {
                    return
                } catch {
                    failedIndexes.append(index)
                    pickError = error.localizedDescription
                    Diagnostics.report(error, context: "photo.picker.prepare")
                }
            }
            if failedIndexes.isEmpty { finishPending(skipFailed: false) }
        }

        private func retryPicked() async {
            guard !failedIndexes.isEmpty else { return }
            preparing = true
            pickError = nil
            let retryIndexes = failedIndexes
            failedIndexes = []
            defer { preparing = false }
            for (offset, index) in retryIndexes.enumerated() {
                do {
                    pendingSelections[index] = try await selection(for: pendingPickedItems[index]) {
                        [self] fraction in
                        Task { @MainActor in
                            preparationProgress = (Double(offset) + fraction) / Double(retryIndexes.count)
                        }
                    }
                } catch is CancellationError {
                    return
                } catch {
                    failedIndexes.append(index)
                    pickError = error.localizedDescription
                    Diagnostics.report(error, context: "photo.picker.prepare.retry")
                }
                preparationProgress = Double(offset + 1) / Double(retryIndexes.count)
            }
            if failedIndexes.isEmpty { finishPending(skipFailed: false) }
        }

        private func selection(
            for item: PhotosPickerItem, progress: @escaping @Sendable (Double) -> Void
        ) async throws -> PhotoSelectionItem {
            if let identifier = item.itemIdentifier,
                let asset = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil).firstObject
            {
                let preview = try await PhotoLibraryIO.shared.thumbnail(
                    for: asset, network: true, progress: progress)
                return PhotoSelectionItem(asset: asset, preview: preview)
            }
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let contentType = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
            return try await Task.detached(priority: .userInitiated) {
                let suffix = UTType(mimeType: contentType)?.preferredFilenameExtension ?? "jpg"
                let file = try PhotoFile.materialize(
                    data: data, filename: "photo.\(suffix)", contentType: contentType, capturedAt: nil)
                return PhotoSelectionItem(file: file, preview: try file.thumbnail())
            }.value
        }

    #endif
    #if os(iOS)
        private func receiveCameraData(_ data: Data) async {
            do {
                let selection = try await Task.detached(priority: .userInitiated) {
                    let file = try PhotoFile.materialize(
                        data: data, filename: "camera-photo.jpg", contentType: "image/jpeg", capturedAt: .now)
                    return PhotoSelectionItem(file: file, preview: try file.thumbnail())
                }.value
                deliver([selection])
            } catch {
                pickError = error.localizedDescription
                Diagnostics.report(error, context: "photo.camera.prepare")
            }
        }
    #endif
    #if os(macOS)
        private func handleFileImport(_ result: Result<[URL], any Error>, retrying: Bool = false) {
            pickError = nil
            do {
                let urls = try result.get()
                if !retrying {
                    pendingSelections = Array(repeating: nil, count: urls.count)
                    failedIndexes = []
                    failedURLs = urls
                    fileImportActive = true
                }
                preparationTask?.cancel()
                preparationTask = Task { await prepareFiles(urls, retrying: retrying) }
            } catch {
                pickError = error.localizedDescription
                Diagnostics.report(error, context: "photo.file.prepare")
            }
        }

        private func prepareFiles(_ urls: [URL], retrying: Bool) async {
            preparing = true
            preparationProgress = 0
            let indexes = retrying ? failedIndexes : Array(urls.indices)
            failedIndexes = []
            defer { preparing = false }
            for (offset, index) in indexes.enumerated() {
                let url = urls[index]
                do {
                    let accessing = url.startAccessingSecurityScopedResource()
                    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
                    pendingSelections[index] = try await Task.detached(priority: .userInitiated) {
                        let file = try PhotoFile.materialize(from: url)
                        return PhotoSelectionItem(file: file, preview: try file.thumbnail())
                    }.value
                } catch is CancellationError {
                    return
                } catch {
                    failedIndexes.append(index)
                    pickError = error.localizedDescription
                    Diagnostics.report(error, context: "photo.file.prepare")
                }
                preparationProgress = Double(offset + 1) / Double(max(1, indexes.count))
            }
            if failedIndexes.isEmpty { finishPending(skipFailed: false) }
        }
    #endif
}

#Preview {
    PhotoSourceButtons { _ in }
        .padding()
        .porcelainScreen()
}
