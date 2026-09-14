import CubbyKit
import Observation
import SwiftUI

/// Imports a library selection as dated garden observations. Each capture day is an editable
/// draft; uploads and entry records are committed in order so a failed day can be retried safely.
struct GardenPhotoImportSheet: View {
    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    let items: [PhotoSelectionItem]
    let onDone: () -> Void
    @State private var importModel: GardenPhotoImportModel?
    @State private var saveTask: Task<Void, Never>?

    var body: some View {
        Group {
            if let importModel {
                GardenPhotoImportContent(model: importModel)
            } else {
                ProgressView()
            }
        }
        .task {
            if importModel == nil {
                importModel = await GardenPhotoImportModel(client: appModel.client, items: items)
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(importModel?.isSaving == true)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    saveTask = Task {
                        defer { saveTask = nil }
                        guard let importModel, await importModel.save() else { return }
                        guard !Task.isCancelled else { return }
                        onDone()
                        dismiss()
                        if let client = importModel.client {
                            Task {
                                guard appModel.client === client else { return }
                                await appModel.photoMatches.refresh(client: client)
                            }
                        }
                    }
                }
                .disabled(importModel?.isReady != true || importModel?.isSaving == true)
            }
        }
        .interactiveDismissDisabled(importModel?.isSaving == true)
        .onDisappear { saveTask?.cancel() }
    }
}

@MainActor
@Observable
final class GardenPhotoImportModel {
    typealias LoadOptions = () async throws -> GardenOptions
    typealias UploadPhoto = (PhotoFile) async throws -> ImageCode
    typealias RecordEntry = (RecordGardenEntry) async throws -> String

    struct Draft: Identifiable {
        let id = UUID()
        var date: Date
        var requiresDateConfirmation: Bool
        var note = ""
        var items: [PhotoSelectionItem]
    }

    private(set) var options = GardenOptions(ingredients: [], locations: [], products: [])
    var locationID = ""
    var plantingID = ""
    var drafts: [Draft]
    private(set) var isLoading = true
    private(set) var optionsLoaded = false
    private(set) var isSaving = false
    private(set) var error: String?
    private(set) var confirmedEntryIDs: [String] = []
    private(set) var uploadedIDs: [ImageCode] = []
    private(set) var confirmedDraftIDs: Set<UUID> = []
    private(set) var selectionError: String?
    private let resolver: GardenPhotoSelectionResolver
    private let recordEntry: RecordEntry
    fileprivate let client: CubbyClient?
    private var committedDestination: (locationID: String, plantingID: String?)?

    convenience init(client: CubbyClient, items: [PhotoSelectionItem]) async {
        let uploader = GardenImageUploader(service: client)
        await self.init(
            items: items,
            client: client,
            loadOptions: { try await client.gardenOptions() },
            uploadPhoto: { file in
                guard let imageID = try await uploader.upload([file]).first else {
                    throw GardenPhotoSelectionResolver.Failure.emptyUpload
                }
                return imageID
            },
            recordEntry: { try await client.recordGardenEntryReturningID($0) })
    }

    init(
        items: [PhotoSelectionItem],
        client: CubbyClient? = nil,
        calendar requestedCalendar: Calendar = .current,
        loadOptions: @escaping LoadOptions,
        uploadPhoto: @escaping UploadPhoto,
        recordEntry: @escaping RecordEntry
    ) async {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = requestedCalendar.timeZone
        let groups = GardenPhotoGrouping.groups(capturedAt: items.map(\.capturedAt), calendar: calendar)
        self.drafts = groups.map { group in
            let date = group.day ?? .now
            return Draft(
                date: date, requiresDateConfirmation: group.day == nil,
                items: group.indexes.map { items[$0] })
        }
        resolver = GardenPhotoSelectionResolver(sourceItems: items, uploadPhoto: uploadPhoto)
        self.recordEntry = recordEntry
        self.client = client
        var didLoadOptions = false
        do {
            options = try await loadOptions()
            didLoadOptions = true
        } catch {
            self.error = error.localizedDescription
            Diagnostics.report(error, context: "garden.photoImport.options")
        }
        optionsLoaded = didLoadOptions
        isLoading = false
    }

    var isReady: Bool {
        !locationID.isEmpty && drafts.contains { !$0.items.isEmpty }
            && !drafts.contains { $0.requiresDateConfirmation && !$0.items.isEmpty }
            && selectionError == nil && !isLoading && optionsLoaded
    }

    func remove(_ itemID: String, from draftID: UUID) {
        guard let index = drafts.firstIndex(where: { $0.id == draftID }) else { return }
        drafts[index].items.removeAll { $0.id == itemID }
        refreshSelectionError()
    }

    func setDate(_ date: Date, for draftID: UUID) {
        guard let index = drafts.firstIndex(where: { $0.id == draftID }) else { return }
        drafts[index].date = date
        drafts[index].requiresDateConfirmation = false
    }

    func save() async -> Bool {
        guard isReady, !isSaving else { return false }
        guard !drafts.contains(where: { $0.items.count > 20 }) else {
            error = "A garden entry can contain at most 20 photos."
            return false
        }
        refreshSelectionError()
        guard selectionError == nil else { return false }
        isSaving = true
        error = nil
        defer { isSaving = false }
        do {
            let destination =
                committedDestination
                ?? (locationID: locationID, plantingID: plantingID.isEmpty ? nil : plantingID)
            for draftIndex in drafts.indices
            where !drafts[draftIndex].items.isEmpty && !confirmedDraftIDs.contains(drafts[draftIndex].id) {
                try Task.checkCancellation()
                let activeItems = drafts.flatMap(\.items)
                let resolution = try await resolver.resolve(
                    drafts[draftIndex].items, activeSelectionIDs: Set(activeItems.map(\.id)))
                apply(resolution)
                try Task.checkCancellation()
                let id = try await recordEntry(
                    RecordGardenEntry(
                        locationID: destination.locationID, plantingID: destination.plantingID,
                        kind: .observation,
                        observedAt: drafts[draftIndex].date,
                        note: drafts[draftIndex].note.isEmpty ? nil : drafts[draftIndex].note,
                        pendingImageIDs: resolution.imageIDs))
                committedDestination = destination
                confirmedEntryIDs.append(id)
                confirmedDraftIDs.insert(drafts[draftIndex].id)
            }
            return true
        } catch is CancellationError {
            return false
        } catch let saveError {
            error = saveError.localizedDescription
            Diagnostics.report(saveError, context: "garden.photoImport.save")
            return false
        }
    }

    private func apply(_ resolution: GardenPhotoSelectionResolver.Resolution) {
        for draftIndex in drafts.indices {
            for itemIndex in drafts[draftIndex].items.indices {
                let selectionID = drafts[draftIndex].items[itemIndex].id
                if let imageID = resolution.resolvedBySelectionID[selectionID] {
                    drafts[draftIndex].items[itemIndex].existingImageID = imageID
                }
            }
        }
        uploadedIDs = uniqueImageIDs(uploadedIDs + resolution.imageIDs)
    }

    private func refreshSelectionError() {
        selectionError = GardenPhotoSelectionResolver.validationError(for: drafts.flatMap(\.items))
    }
}

/// Resolves library-review aliases against the active selection graph. Successful resolutions are
/// memoized so a later entry failure can retry without uploading the same bytes again.
@MainActor
final class GardenPhotoSelectionResolver {
    struct Resolution {
        let imageIDs: [ImageCode]
        let resolvedBySelectionID: [String: ImageCode]
    }

    enum Failure: LocalizedError {
        case emptyUpload
        case unavailableSource(String)
        case cyclicReference(String)

        var errorDescription: String? {
            switch self {
            case .emptyUpload:
                "The photo upload finished without an image ID. Try again."
            case .unavailableSource(let id):
                "A matched source photo (\(id)) was removed. Add it again or choose a different match."
            case .cyclicReference(let id):
                "The matched photos contain an invalid reference involving \(id). Review the matches and try again."
            }
        }
    }

    private var sourceItemsByID: [String: PhotoSelectionItem]
    private(set) var resolvedBySelectionID: [String: ImageCode] = [:]
    private var resolving: Set<String> = []
    private let uploadPhoto: GardenPhotoImportModel.UploadPhoto

    init(sourceItems: [PhotoSelectionItem], uploadPhoto: @escaping GardenPhotoImportModel.UploadPhoto) {
        sourceItemsByID = Dictionary(uniqueKeysWithValues: sourceItems.map { ($0.id, $0) })
        self.uploadPhoto = uploadPhoto
    }

    func resolve(_ items: [PhotoSelectionItem], activeSelectionIDs: Set<String>? = nil) async throws
        -> Resolution
    {
        try Task.checkCancellation()
        for item in items { sourceItemsByID[item.id] = item }
        let activeIDs = activeSelectionIDs ?? Set(items.map(\.id))
        if let sourceID = Self.missingSourceID(sourceItems: sourceItemsByID, activeIDs: activeIDs) {
            throw Failure.unavailableSource(sourceID)
        }

        var imageIDs: [ImageCode] = []
        var resolved: [String: ImageCode] = [:]
        for item in items {
            try Task.checkCancellation()
            let imageID = try await resolveSelection(item.id, activeIDs: activeIDs)
            if !imageIDs.contains(imageID) { imageIDs.append(imageID) }
            resolved[item.id] = imageID
        }
        for id in activeIDs {
            if let imageID = resolvedBySelectionID[id] { resolved[id] = imageID }
        }
        return Resolution(imageIDs: imageIDs, resolvedBySelectionID: resolved)
    }

    static func validationError(for items: [PhotoSelectionItem]) -> String? {
        let sources = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        guard let sourceID = missingSourceID(sourceItems: sources, activeIDs: Set(sources.keys)) else {
            return nil
        }
        return Failure.unavailableSource(sourceID).localizedDescription
    }

    private static func missingSourceID(
        sourceItems: [String: PhotoSelectionItem], activeIDs: Set<String>
    ) -> String? {
        for item in sourceItems.values where activeIDs.contains(item.id) {
            guard let imageID = item.existingImageID, let sourceID = draftSourceID(imageID) else {
                continue
            }
            guard activeIDs.contains(sourceID), sourceItems[sourceID] != nil else { return sourceID }
        }
        return nil
    }

    private func resolveSelection(_ selectionID: String, activeIDs: Set<String>) async throws -> ImageCode {
        try Task.checkCancellation()
        guard activeIDs.contains(selectionID), let item = sourceItemsByID[selectionID] else {
            throw Failure.unavailableSource(selectionID)
        }
        if let resolved = resolvedBySelectionID[selectionID] { return resolved }
        guard resolving.insert(selectionID).inserted else { throw Failure.cyclicReference(selectionID) }
        defer { resolving.remove(selectionID) }

        let resolved: ImageCode
        if let existing = item.existingImageID {
            if let sourceID = Self.draftSourceID(existing) {
                resolved = try await resolveSelection(sourceID, activeIDs: activeIDs)
            } else {
                resolved = existing
            }
        } else {
            try Task.checkCancellation()
            let file = try await item.materialize()
            try Task.checkCancellation()
            resolved = try await uploadPhoto(file)
        }
        resolvedBySelectionID[selectionID] = resolved
        return resolved
    }

    private static func draftSourceID(_ imageID: ImageCode) -> String? {
        guard imageID.rawValue.hasPrefix("draft:") else { return nil }
        return String(imageID.rawValue.dropFirst("draft:".count))
    }
}

func uniqueImageIDs(_ ids: [ImageCode]) -> [ImageCode] {
    var seen: Set<ImageCode> = []
    return ids.filter { seen.insert($0).inserted }
}

func gardenPhotoLabel(_ item: PhotoSelectionItem) -> String {
    guard let capturedAt = item.capturedAt else { return "Garden photo · date unavailable" }
    return "Garden photo · \(capturedAt.formatted(date: .abbreviated, time: .shortened))"
}

private struct GardenPhotoImportContent: View {
    @Bindable var model: GardenPhotoImportModel

    var body: some View {
        Form {
            if let error = model.error {
                Text(error).foregroundStyle(PorcelainTokens.destructive)
            }
            if let selectionError = model.selectionError {
                Text(selectionError).foregroundStyle(PorcelainTokens.destructive)
            }
            Section("Where") {
                Picker("Location", selection: $model.locationID) {
                    Text("Choose a location").tag("")
                    ForEach(model.options.locations) { Text($0.name).tag($0.id) }
                }
                Picker("About", selection: $model.plantingID) {
                    Text("Whole bed").tag("")
                    ForEach(model.options.plantings) { Text($0.name).tag($0.id) }
                }
            }
            .disabled(model.isSaving || !model.confirmedDraftIDs.isEmpty)
            ForEach($model.drafts) { $draft in
                Section(draft.date.formatted(date: .abbreviated, time: .omitted)) {
                    GardenObservationDatePicker(
                        selection: Binding(
                            get: { draft.date },
                            set: { model.setDate($0, for: draft.id) }))
                    if draft.requiresDateConfirmation {
                        Label(
                            "This photo has no capture date. Confirm the observation date.",
                            systemImage: "calendar.badge.exclamationmark"
                        )
                        .font(.porcelainLabel)
                        .foregroundStyle(PorcelainTokens.destructive)
                        Button("Use \(draft.date.formatted(date: .abbreviated, time: .omitted))") {
                            model.setDate(draft.date, for: draft.id)
                        }
                    }
                    TextField("Observation", text: $draft.note, axis: .vertical)
                    PhotoBatch(
                        photos: draft.items.map {
                            PhotoAttachment(
                                id: $0.id, filename: gardenPhotoLabel($0), source: .local($0.preview),
                                imageID: $0.existingImageID?.rawValue,
                                status: $0.existingImageID == nil ? nil : "Ready")
                        },
                        onRemove: { model.remove($0, from: draft.id) })
                }
                .disabled(model.confirmedDraftIDs.contains(draft.id))
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Import garden photos")
    }
}

#Preview {
    GardenPhotoImportSheet(items: [], onDone: {})
        .environment(PreviewFixtures.signedInModel())
}
