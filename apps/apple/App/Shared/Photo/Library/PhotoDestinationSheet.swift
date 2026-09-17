import CubbyKit
import Observation
import SwiftUI

/// Chooses where a selected batch belongs, then hands the same ordered values to match review and
/// upload. "New ‹entity›" skips picking an existing record: the batch uploads as unattached
/// pending images, then opens the generic create editor prefilled with them (`photoCreatePrefill`)
/// for any gallery entity the catalog exposes create for — the entity list is read off
/// `EntityCatalog`, never hard-coded, so a new gallery entity picks this up automatically.
struct PhotoDestinationSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onDone: () -> Void
    @State private var flow: PhotoImportFlowModel

    init(items: [PhotoSelectionItem], onDone: @escaping () -> Void) {
        self.onDone = onDone
        _flow = State(initialValue: PhotoImportFlowModel(items: items))
    }

    /// Every gallery entity the generic create editor can open, sorted for a stable menu.
    private var createOptions: [PhotoDestinationOption] {
        EntityCatalog.all
            .filter { $0.key.nativeActions.contains(.create) && $0.acceptsImages }
            .sorted { $0.plural < $1.plural }
            .map { PhotoDestinationOption(kind: .create, descriptor: $0) }
    }

    private var existingOptions: [PhotoDestinationOption] {
        EntityCatalog.all.filter(\.acceptsImages).map {
            PhotoDestinationOption(kind: .existing, descriptor: $0)
        }
    }

    var body: some View {
        NavigationStack(path: $flow.path) {
            List {
                Section("Create a new record") {
                    ForEach(createOptions) { option in
                        Button {
                            flow.chooseCreate(option.descriptor.key)
                        } label: {
                            Label(
                                option.title,
                                systemImage: entitySymbol(for: option.descriptor.key)
                            )
                        }
                        .accessibilityIdentifier(
                            "photos.destination.create.\(option.descriptor.key.rawValue)")
                    }
                }
                Section("Add to a Cubby record") {
                    ForEach(existingOptions) { option in
                        NavigationLink(
                            value: PhotoImportRoute.entityPicker(option.descriptor.key.rawValue)
                        ) {
                            Label(
                                option.title,
                                systemImage: entitySymbol(for: option.descriptor.key))
                        }
                        .accessibilityIdentifier(
                            "photos.destination.\(option.descriptor.key.rawValue)")
                    }
                }
            }
            .navigationTitle("Add to…")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .navigationDestination(for: PhotoImportRoute.self) { route in
                destination(for: route)
            }
        }
        .nativeSheet(.photo)
    }

    @ViewBuilder
    private func destination(for route: PhotoImportRoute) -> some View {
        switch route {
        case .entityPicker(let rawKey):
            if let key = EntityKey(rawValue: rawKey) {
                PhotoEntityChooser(key: key, captureDates: flow.items.map(\.capturedAt)) {
                    flow.chooseEntity(key, id: $0)
                }
            } else {
                ContentUnavailableView("Destination unavailable", systemImage: "exclamationmark.triangle")
            }
        case .review:
            PhotoMatchReviewContent(
                draft: flow.reviewDraft,
                onCancel: { dismiss() },
                onContinue: { flow.completeReview($0) })
        case .entityUpload(let rawKey, let id):
            if let key = EntityKey(rawValue: rawKey) {
                PhotoUploadProgress(items: flow.reviewItems, key: key, id: id, onDone: finish)
            } else {
                ContentUnavailableView("Destination unavailable", systemImage: "exclamationmark.triangle")
            }
        case .entityCreate(let rawKey):
            if let key = EntityKey(rawValue: rawKey) {
                PhotoEntityCreateUpload(items: flow.reviewItems, key: key, onDone: finish)
            } else {
                ContentUnavailableView("Destination unavailable", systemImage: "exclamationmark.triangle")
            }
        }
    }

    private func finish() {
        onDone()
        dismiss()
    }
}

struct PhotoDestinationOption: Identifiable {
    enum Kind: Hashable {
        case create
        case existing
    }

    enum ID: Hashable {
        case create(EntityKey)
        case existing(EntityKey)
    }

    let kind: Kind
    let descriptor: EntityDescriptor

    var id: ID {
        switch kind {
        case .create: .create(descriptor.key)
        case .existing: .existing(descriptor.key)
        }
    }
    var title: String {
        switch kind {
        case .create: "New \(descriptor.singular)"
        case .existing: descriptor.plural
        }
    }
}

enum PhotoImportDestination: Equatable {
    case entity(EntityKey, id: String)
    case create(EntityKey)
}

enum PhotoImportRoute: Hashable {
    case entityPicker(String)
    case review
    case entityUpload(String, String)
    case entityCreate(String)
}

@MainActor
@Observable
final class PhotoImportFlowModel {
    let items: [PhotoSelectionItem]
    let reviewDraft: PhotoReviewDraft
    var path: [PhotoImportRoute] = []
    private(set) var destination: PhotoImportDestination?
    private(set) var reviewedItems: [PhotoSelectionItem]?

    init(items: [PhotoSelectionItem]) {
        self.items = items
        reviewDraft = PhotoReviewDraft(items: items)
    }

    var reviewItems: [PhotoSelectionItem] { reviewedItems ?? items }

    func chooseCreate(_ key: EntityKey) {
        destination = .create(key)
        path.append(.review)
    }

    func chooseEntity(_ key: EntityKey, id: String) {
        destination = .entity(key, id: id)
        path.append(.review)
    }

    func completeReview(_ items: [PhotoSelectionItem]) {
        reviewedItems = items
        switch destination {
        case .create(let key):
            path.append(.entityCreate(key.rawValue))
        case .entity(let key, let id):
            path.append(.entityUpload(key.rawValue, id))
        case nil:
            break
        }
    }
}

private struct PhotoEntityChooser: View {
    @Environment(AppModel.self) private var appModel
    let key: EntityKey
    let captureDates: [Date?]
    let onSelect: (String) -> Void
    @State private var model: PhotoEntityChooserModel?

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        Group {
            if let model {
                if model.isSearching {
                    searchContent(model)
                } else if !model.dateMatches.isEmpty || !model.recentRows.isEmpty {
                    destinationList(model)
                } else {
                    emptyState(model)
                }
            } else {
                LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
            }
        }
        .navigationTitle(descriptor.plural)
        .modifier(
            PhotoEntitySearchModifier(
                enabled: descriptor.primarySearch != nil,
                text: Binding(
                    get: { model?.search?.query ?? "" },
                    set: { model?.setSearchQuery($0) }
                ),
                prompt: descriptor.primarySearch?.placeholder
                    ?? "Search \(descriptor.plural.lowercased()) or shortcode"
            )
        )
        .task(id: key) {
            if model == nil {
                model = PhotoEntityChooserModel(
                    descriptor: descriptor, captureDates: captureDates,
                    loader: { filters, query, page, sort in
                        var requestFilters = filters
                        if let query, !query.isEmpty {
                            requestFilters.set(.single(query), for: "searchQuery")
                        }
                        return try await appModel.client.list(
                            descriptor, page: page, pageSize: 25, sort: sort, filters: requestFilters)
                    })
            }
            await model?.loadInitial()
        }
        .refreshControl { await model?.refresh() }
    }

    @ViewBuilder
    private func emptyState(_ model: PhotoEntityChooserModel) -> some View {
        if model.isLoading {
            LoadingIndicator.screen(label: "Loading \(descriptor.plural)")
        } else if let message = model.dateError ?? model.recentError {
            ContentUnavailableView {
                Label("Couldn't load \(descriptor.plural)", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Retry") { Task { await model.refresh() } }
                    .accessibilityIdentifier("photos.destination.retry")
            }
        } else {
            ContentUnavailableView("No \(descriptor.plural) yet", systemImage: entitySymbol(for: key))
        }
    }

    private func destinationList(_ model: PhotoEntityChooserModel) -> some View {
        List {
            if model.hasDateMatches {
                Section {
                    if let error = model.dateError {
                        Text(error).foregroundStyle(.secondary)
                        Button("Retry date matches") { Task { await model.refresh() } }
                    }
                    ForEach(model.dateMatches) { row in destinationRow(row, model: model) }
                    if model.hasMoreDateMatches {
                        Button {
                            Task { await model.loadMoreDateMatches() }
                        } label: {
                            if model.isLoadingDateNextPage {
                                LoadingIndicator(label: "Loading more matches")
                            } else {
                                Text("Load more matches")
                            }
                        }
                        .disabled(model.isLoadingDateNextPage)
                    }
                } header: {
                    Text(
                        "Matches \(model.captureDate?.formatted(date: .abbreviated, time: .omitted) ?? "photo date")"
                    )
                }
            }
            Section {
                if let error = model.recentError {
                    Text(error).foregroundStyle(.secondary)
                    Button("Retry recent records") { Task { await model.refresh() } }
                }
                ForEach(model.recentRows) { row in destinationRow(row, model: model) }
                if model.hasMoreRecents {
                    Button {
                        Task { await model.loadMoreRecents() }
                    } label: {
                        if model.isLoadingRecentNextPage {
                            LoadingIndicator(label: "Loading more recent records")
                        } else {
                            Text("Load more recent records")
                        }
                    }
                    .disabled(model.isLoadingRecentNextPage)
                }
            } header: {
                Text("Recently edited")
            }
        }
    }

    @ViewBuilder
    private func searchContent(_ model: PhotoEntityChooserModel) -> some View {
        if let search = model.search {
            if search.rows.isEmpty {
                switch search.phase {
                case .idle, .debouncing, .loading:
                    LoadingIndicator.screen(label: "Searching \(descriptor.plural)")
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Couldn't search \(descriptor.plural)", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Retry") { search.retry() }
                    }
                case .loaded:
                    ContentUnavailableView("No matching \(descriptor.plural)", systemImage: "magnifyingglass")
                }
            } else {
                List {
                    ForEach(search.rows) { row in destinationRow(row, model: model) }
                    if search.hasMore {
                        Button {
                            Task { await search.loadNextPage() }
                        } label: {
                            if search.phase == .loading {
                                LoadingIndicator(label: "Loading more \(descriptor.plural)")
                            } else {
                                Text("Load more")
                            }
                        }
                        .disabled(search.phase != .loaded)
                    }
                }
            }
        } else {
            ContentUnavailableView("Search unavailable", systemImage: "magnifyingglass")
        }
    }

    @ViewBuilder
    private func destinationRow(_ row: EntityRow, model: PhotoEntityChooserModel) -> some View {
        Button {
            onSelect(row.id)
        } label: {
            EntityRowView(key: key, row: row, photoMode: true)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("photos.destination.row.\(row.id)")
    }
}

private struct PhotoEntitySearchModifier: ViewModifier {
    let enabled: Bool
    @Binding var text: String
    let prompt: String

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.searchable(text: $text, prompt: prompt)
        } else {
            content
        }
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
                        Button("Cancel upload") { uploader.cancel() }
                            .accessibilityIdentifier("photos.upload.cancel")
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
                        .accessibilityIdentifier("photos.upload.commit")
                    }
                }
                .padding(PorcelainTokens.Space.lg)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }.disabled(uploader.isRunning)
                    }
                }
            } else {
                LoadingIndicator(label: "Preparing upload")
            }
        }
        .task {
            if uploader == nil {
                uploader = PhotoBatchUploadModel(client: appModel.client, items: items, key: key, id: id)
            }
        }
        .interactiveDismissDisabled(uploader?.isRunning == true)
        .navigationBarBackButtonHidden(uploader?.hasStarted == true)
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
    private(set) var hasStarted = false
    var makeCover = false

    init(client: CubbyClient, items: [PhotoSelectionItem], key: EntityKey, id: String) {
        self.client = client; self.items = items; self.key = key; self.id = id
    }

    func run() async {
        guard !finished, !isRunning else { return }
        hasStarted = true
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
            if makeCover {
                status = "Updating photo order…"
                let existing = try await client.imageIDs(entity: key, id: id)
                var seen = Set<ImageCode>()
                let order = (attached + existing).filter { seen.insert($0).inserted }
                try await client.setImageOrder(order, entity: key, id: id)
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

    private func appModelRefresh() async {
        if let model = AppModel.active, model.client === client {
            await model.photoMatches.refresh(client: client)
        }
    }
}

// MARK: - Create with prefill

/// The "New ‹entity›" destination: uploads the reviewed selection as unattached pending images,
/// then opens the generic create editor prefilled with them and (for the entities that have one) a
/// date field defaulted to the selection's earliest capture date rather than today.
private struct PhotoEntityCreateUpload: View {
    let items: [PhotoSelectionItem]
    let key: EntityKey
    let onDone: () -> Void
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var uploader: PhotoCreateUploadModel?

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    var body: some View {
        Group {
            if let uploader {
                VStack(spacing: PorcelainTokens.Space.lg) {
                    if let error = uploader.error {
                        Text(error).foregroundStyle(PorcelainTokens.destructive)
                        Button("Retry") { Task { await uploader.run() } }
                    } else {
                        ProgressView(uploader.status)
                    }
                }
                .padding(PorcelainTokens.Space.lg)
            } else {
                LoadingIndicator(label: "Preparing upload")
            }
        }
        .navigationTitle("New \(descriptor.singular)")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .interactiveDismissDisabled()
        .task {
            if uploader == nil {
                let model = PhotoCreateUploadModel(client: appModel.client, items: items, key: key)
                uploader = model
                await model.run()
            }
        }
        .sheet(isPresented: editorPresented) {
            EntityEditorSheet(key: key, mode: .create(prefill: prefill)) { _ in
                onDone()
                dismiss()
            }
            .environment(appModel)
        }
    }

    /// Shown once the upload has produced ids; dismissing it without saving backs out of the
    /// whole "Add to…" flow rather than leaving the upload screen stranded behind it.
    private var editorPresented: Binding<Bool> {
        Binding(
            get: { uploader?.imageIDs != nil },
            set: { presented in if !presented { dismiss() } }
        )
    }

    private var prefill: [String: JSONValue] {
        photoCreatePrefill(
            for: descriptor, imageIDs: uploader?.imageIDs ?? [],
            earliestCapturedAt: items.compactMap(\.capturedAt).min())
    }
}

@MainActor
@Observable
private final class PhotoCreateUploadModel {
    let client: CubbyClient
    let items: [PhotoSelectionItem]
    let key: EntityKey
    private var uploadedBySelection: [String: ImageCode] = [:]
    private(set) var status = "Uploading photos…"
    private(set) var error: String?
    private(set) var imageIDs: [ImageCode]?

    init(client: CubbyClient, items: [PhotoSelectionItem], key: EntityKey) {
        self.client = client
        self.items = items
        self.key = key
    }

    func run() async {
        guard imageIDs == nil else { return }
        error = nil
        do {
            let uploader = PendingImageUploader(entity: key, service: client)
            var ids: [ImageCode] = []
            for (offset, item) in items.enumerated() {
                if let uploaded = uploadedBySelection[item.id] {
                    ids.append(uploaded)
                    continue
                }
                if let existing = try resolve(item.existingImageID, for: item.id) {
                    uploadedBySelection[item.id] = existing
                    ids.append(existing)
                    continue
                }
                status = "Uploading photo \(offset + 1) of \(items.count)…"
                let file = try await item.materialize()
                guard let uploaded = try await uploader.upload([file]).first else { continue }
                uploadedBySelection[item.id] = uploaded
                ids.append(uploaded)
            }
            imageIDs = ids
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "photos.destination.create")
        }
    }

    /// Resolves a same-batch "draft:" placeholder (a duplicate the review matched to a sibling
    /// item not yet uploaded) to the id that sibling's upload produced.
    private func resolve(_ imageID: ImageCode?, for selectionID: String) throws -> ImageCode? {
        guard let imageID else { return nil }
        guard imageID.rawValue.hasPrefix("draft:") else { return imageID }
        let sourceID = String(imageID.rawValue.dropFirst("draft:".count))
        guard let resolved = uploadedBySelection[sourceID] ?? uploadedBySelection[selectionID]
        else { throw CocoaError(.fileNoSuchFile) }
        return resolved
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    PhotoDestinationSheet(items: [], onDone: {})
}
