import CubbyKit
import Observation
import SwiftUI

/// Chooses where a selected batch belongs, then hands the same ordered values to match review and
/// upload. Garden entries have their own destination because their pending images finalize with
/// the entry attachment mutation.
struct PhotoDestinationSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let items: [PhotoSelectionItem]
    let onDone: () -> Void
    @State private var destination: PhotoDestination?

    var body: some View {
        NavigationStack {
            List {
                Section("Garden") {
                    Button {
                        destination = .garden
                    } label: {
                        Label("New garden entries", systemImage: "leaf")
                    }
                }
                Section("Add to a Cubby record") {
                    ForEach(EntityCatalog.all.filter(\.acceptsImages), id: \.key) { descriptor in
                        NavigationLink {
                            PhotoEntityChooser(
                                key: descriptor.key,
                                onSelect: { id in destination = .entity(descriptor.key, id: id) })
                        } label: {
                            Label(descriptor.plural, systemImage: entitySymbol(for: descriptor.key))
                        }
                    }
                }
            }
            .navigationTitle("Add to…")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        #if os(macOS)
            .frame(minWidth: 520, idealWidth: 620, minHeight: 520, idealHeight: 680)
        #endif
        .sheet(item: $destination) { destination in
            switch destination {
            case .garden:
                PhotoGardenReviewFlow(items: items, onDone: finish)
            case .entity(let key, let id):
                PhotoEntityReviewFlow(items: items, key: key, id: id, onDone: finish)
            }
        }
    }

    private func finish() {
        onDone()
        dismiss()
    }
}

private struct PhotoGardenReviewFlow: View {
    let items: [PhotoSelectionItem]
    let onDone: () -> Void
    @State private var reviewedItems: [PhotoSelectionItem]?

    var body: some View {
        Group {
            if let reviewedItems {
                NavigationStack {
                    GardenPhotoImportSheet(items: reviewedItems, onDone: onDone)
                }
            } else {
                PhotoMatchReviewSheet(items: items, dismissOnContinue: false) {
                    reviewedItems = $0
                }
            }
        }
        #if os(macOS)
            .frame(minWidth: 540, minHeight: 620)
        #endif
    }
}

private enum PhotoDestination: Identifiable {
    case garden
    case entity(EntityKey, id: String)

    var id: String {
        switch self {
        case .garden: "garden"
        case .entity(let key, let id): "\(key.rawValue):\(id)"
        }
    }
}

private struct PhotoEntityChooser: View {
    @Environment(AppModel.self) private var appModel
    let key: EntityKey
    let onSelect: (String) -> Void
    @State private var rows: [EntityRow] = []
    @State private var page = 1
    @State private var hasMore = false
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(PorcelainTokens.destructive) }
            ForEach(rows) { row in
                Button {
                    onSelect(row.id)
                } label: {
                    EntityRowView(key: key, row: row)
                }
                .buttonStyle(.plain)
            }
            if hasMore {
                Button(loading ? "Loading…" : "Load more") { Task { await loadMore() } }
                    .disabled(loading)
            }
        }
        .navigationTitle(EntityCatalog[key].plural)
        .task { await loadMore(reset: true) }
    }

    private func loadMore(reset: Bool = false) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        let nextPage = reset ? 1 : page + 1
        do {
            let result = try await appModel.client.list(EntityCatalog[key], page: nextPage, pageSize: 50)
            if reset { rows = result.items } else { rows.append(contentsOf: result.items) }
            page = nextPage
            hasMore = result.meta.totalCount > rows.count
            error = nil
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "photos.destination.list")
        }
    }
}

private struct PhotoEntityReviewFlow: View {
    let items: [PhotoSelectionItem]
    let key: EntityKey
    let id: String
    let onDone: () -> Void
    @State private var reviewedItems: [PhotoSelectionItem]?

    var body: some View {
        Group {
            if let reviewedItems {
                PhotoUploadProgress(items: reviewedItems, key: key, id: id, onDone: onDone)
            } else {
                PhotoMatchReviewSheet(items: items, dismissOnContinue: false) { reviewedItems = $0 }
            }
        }
        #if os(macOS)
            .frame(minWidth: 540, minHeight: 620)
        #endif
    }
}

private struct PhotoUploadProgress: View {
    let items: [PhotoSelectionItem]
    let key: EntityKey
    let id: String
    let onDone: () -> Void
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var uploader: PhotoBatchUploadModel?

    var body: some View {
        NavigationStack {
            Group {
                if let uploader {
                    VStack(spacing: PorcelainTokens.Space.lg) {
                        if let error = uploader.error {
                            Text(error).foregroundStyle(PorcelainTokens.destructive)
                        }
                        if uploader.finished {
                            Label(
                                "Added \(items.count) photo\(items.count == 1 ? "" : "s")",
                                systemImage: "checkmark.circle")
                        } else if uploader.isRunning {
                            ProgressView(uploader.status)
                            Button("Cancel") { uploader.cancel() }
                        } else {
                            if key == .product {
                                Toggle(
                                    "Make first photo the cover",
                                    isOn: Binding(
                                        get: { uploader.makeCover },
                                        set: { uploader.makeCover = $0 }))
                            }
                            Button(uploader.error == nil ? "Add photos" : "Retry") {
                                Task {
                                    await uploader.run()
                                    if uploader.finished { onDone(); dismiss() }
                                }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(PorcelainTokens.Space.lg)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { dismiss() }.disabled(uploader.isRunning)
                        }
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .task {
            if uploader == nil {
                uploader = PhotoBatchUploadModel(client: appModel.client, items: items, key: key, id: id)
            }
        }
        .interactiveDismissDisabled(uploader?.isRunning == true)
        .onDisappear { uploader?.cancel() }
        .navigationTitle("Adding photos")
    }
}

@MainActor
@Observable
private final class PhotoBatchUploadModel {
    let client: CubbyClient
    let items: [PhotoSelectionItem]
    let key: EntityKey
    let id: String
    private var checkpoints: [String: PhotoUploader.Checkpoint] = [:]
    private var uploadedBySelection: [String: ImageCode] = [:]
    private var currentSelectionID: String?
    private var cancelled = false
    private var uploadTask: Task<Void, Never>?
    private(set) var status = "Preparing photos…"
    private(set) var error: String?
    private(set) var finished = false
    private(set) var isRunning = false
    var makeCover = false

    init(client: CubbyClient, items: [PhotoSelectionItem], key: EntityKey, id: String) {
        self.client = client; self.items = items; self.key = key; self.id = id
    }

    func run() async {
        guard !finished, !isRunning else { return }
        isRunning = true
        cancelled = false
        let task = Task { await performRun() }
        uploadTask = task
        await task.value
        uploadTask = nil
        isRunning = false
    }

    private func performRun() async {
        error = nil
        do {
            var attached: [ImageCode] = []
            if key == .gardenEntry {
                let entry = try await client.gardenEntry(id: id)
                var represented = Set(entry.images.map(\.id))
                var selectedReferences: [String: String] = [:]
                for item in items {
                    let reference: String
                    if let existing = item.existingImageID {
                        if existing.rawValue.hasPrefix("draft:") {
                            let source = String(existing.rawValue.dropFirst("draft:".count))
                            guard let prior = selectedReferences[source] else {
                                throw GardenPhotoSelectionResolver.Failure.unavailableSource(source)
                            }
                            reference = prior
                        } else {
                            reference = existing.rawValue
                        }
                    } else {
                        reference = "selection:\(item.id)"
                    }
                    selectedReferences[item.id] = reference
                    represented.insert(reference)
                }
                guard represented.count <= 20 else {
                    error =
                        "A garden entry can contain at most 20 photos. Close this review and choose fewer photos."
                    return
                }
                let gardenUploader = GardenImageUploader(service: client)
                for item in items {
                    try checkCancelled()
                    currentSelectionID = item.id
                    let imageID = try await resolveOrUpload(item, gardenUploader: gardenUploader)
                    attached.append(imageID)
                }
                try await client.attachImages(attached, to: key, id: id)
            } else {
                let photoUploader = PhotoUploader(service: client)
                for item in items {
                    try checkCancelled()
                    currentSelectionID = item.id
                    if let uploaded = uploadedBySelection[item.id] {
                        attached.append(uploaded)
                        continue
                    }
                    if let existing = try resolve(item.existingImageID, for: item.id) {
                        try await client.attachImages([existing], to: key, id: id)
                        uploadedBySelection[item.id] = existing
                        attached.append(existing)
                        continue
                    }
                    let file = try await materialize(item)
                    status = "Uploading photo…"
                    let outcome = try await photoUploader.upload(
                        PhotoUploader.Request(file: file, entity: key, entityID: id),
                        resuming: checkpoints[item.id])
                    uploadedBySelection[item.id] = outcome.imageID
                    attached.append(outcome.imageID)
                }
            }
            if key == .product && makeCover {
                status = "Updating photo order…"
                let existing = try await client.productImageIDs(ProductCode(id))
                var seen = Set<ImageCode>()
                let order = (attached + existing).filter { seen.insert($0).inserted }
                try await client.setImageOrder(order, product: ProductCode(id))
            }
            finished = true
            await appModelRefresh()
        } catch is CancellationError {
            error = nil
        } catch let failure as PhotoUploader.Failure {
            if let checkpoint = failure.checkpoint, let currentSelectionID {
                checkpoints[currentSelectionID] = checkpoint
            }
            error = failure.underlying.localizedDescription
            Diagnostics.report(failure.underlying, context: "photos.destination.upload")
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "photos.destination.upload")
        }
    }

    func cancel() {
        cancelled = true
        uploadTask?.cancel()
    }

    private func checkCancelled() throws {
        try Task.checkCancellation()
        if cancelled { throw CancellationError() }
    }

    private func materialize(_ item: PhotoSelectionItem) async throws -> PhotoFile {
        status = "Preparing full-quality photo…"
        return try await item.materialize { [weak self] fraction in
            Task { @MainActor in
                guard let self, !self.cancelled, self.currentSelectionID == item.id else { return }
                self.status = "Downloading photo… \(Int(fraction * 100))%"
            }
        }
    }

    private func resolve(_ imageID: ImageCode?, for selectionID: String) throws -> ImageCode? {
        guard let imageID else { return nil }
        guard imageID.rawValue.hasPrefix("draft:") else { return imageID }
        let sourceID = String(imageID.rawValue.dropFirst("draft:".count))
        guard let resolved = uploadedBySelection[sourceID] ?? uploadedBySelection[selectionID]
        else { throw CocoaError(.fileNoSuchFile) }
        return resolved
    }

    private func resolveOrUpload(_ item: PhotoSelectionItem, gardenUploader: GardenImageUploader) async throws
        -> ImageCode
    {
        if let uploaded = uploadedBySelection[item.id] { return uploaded }
        if let existing = try resolve(item.existingImageID, for: item.id) { return existing }
        let file = try await materialize(item)
        status = "Uploading garden photo…"
        let ids = try await gardenUploader.upload([file])
        guard let id = ids.first else { throw CocoaError(.fileWriteUnknown) }
        uploadedBySelection[item.id] = id
        return id
    }

    private func appModelRefresh() async {
        if let model = AppModel.active, model.client === client {
            await model.photoMatches.refresh(client: client)
        }
    }
}

#Preview {
    PhotoDestinationSheet(items: [], onDone: {})
        .environment(PreviewFixtures.signedInModel())
}
