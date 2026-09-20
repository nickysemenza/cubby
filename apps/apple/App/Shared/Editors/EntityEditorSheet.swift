import CubbyKit
import SwiftUI

/// The generic create/update editor for any entity the generated client can write: the catalog's
/// editor sections as a grouped `Form`, a photo block for an image-attachable entity, Cancel →
/// Discard through `DraftDismissalState`, Save gated on `GenericEntityEditModel.canSave`.
///
/// Structured fields the catalog declares that native does not render remain in the web editor
/// (product `unitMappings`, recipe `sections`/`yield`/`meta`, expense evidence, financial-account
/// identity, and financial-transaction source refs). Typed generic controls, entity references,
/// amounts, tags, and vendor names render through `EntityFieldControl`; image keys render through
/// `EntityImageBlock`.
struct EntityEditorSheet: View {
    let key: EntityKey
    let mode: GenericEntityEditModel.Mode
    /// The loaded record for an update editor opened from a detail screen (skips the fetch).
    var original: JSONValue? = nil
    let onSaved: (String) -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var model: GenericEntityEditModel?
    @State private var initialDraft: [String: JSONValue] = [:]
    @State private var selections: [PhotoSelectionItem] = []
    @State private var pickedTitles: [String: String] = [:]
    @State private var uploadStatus: String?
    @State private var isUploading = false
    @State private var draftDismissal = DraftDismissalState()
    @State private var saveTask: Task<Void, Never>?
    @State private var finishesAfterDismissal = false

    private var descriptor: EntityDescriptor { EntityCatalog[key] }

    private var isCreate: Bool {
        if case .create = mode { return true }
        return false
    }

    private var unsupportedFields: [FieldDescriptor] {
        descriptor.fields.filter { field in
            let participates = isCreate ? field.inCreate : field.inUpdate
            return participates && NativePresentationCoverage.unsupportedControl(field) != nil
        }
    }

    private var unsupportedRequiredFields: [FieldDescriptor] {
        guard isCreate else { return [] }
        return unsupportedFields.filter(\.requiredOnCreate)
    }

    /// Keys the photo block owns; they never render as field controls.
    private static let imageKeys: Set<String> = ["pendingImageIds", "removeImageIds", "imageOrder"]

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    form(model)
                } else {
                    LoadingIndicator.screen()
                }
            }
            .navigationTitle(title)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isSaving ? "Close" : "Cancel") {
                        draftDismissal.request(isDirty: isDirty, isSaving: isSaving, dismiss: dismiss)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { startSave() }
                        .disabled(
                            !(model?.canSave ?? false) || !unsupportedRequiredFields.isEmpty || isSaving
                        )
                        .accessibilityIdentifier("editor.\(key.rawValue).save")
                }
            }
        }
        .nativeSheet(.editor)
        .draftDismissal(
            $draftDismissal, isDirty: isDirty, isSaving: isSaving,
            onDiscard: { dismiss() },
            onCloseWhileSaving: {
                finishesAfterDismissal = true
                dismiss()
            }
        )
        .onDisappear {
            if !finishesAfterDismissal { saveTask?.cancel() }
        }
        .task { await setup() }
    }

    private var title: String {
        switch mode {
        case .create: "New \(descriptor.singular)"
        case .update: "Edit \(descriptor.singular)"
        }
    }

    private var isSaving: Bool { isUploading || (model?.isSaving ?? false) }

    private var isDirty: Bool {
        guard let model else { return false }
        return model.draft != initialDraft || !selections.isEmpty || model.hasImageChanges
    }

    private func form(_ model: GenericEntityEditModel) -> some View {
        Form {
            if !unsupportedFields.isEmpty {
                Section {
                    Text(
                        unsupportedRequiredFields.isEmpty
                            ? "Additional fields are available on web."
                            : "This record needs additional fields available on web to create it."
                    )
                    .foregroundStyle(.secondary)
                }
            }
            if let banner = model.bannerError {
                Section {
                    Text(banner).foregroundStyle(PorcelainTokens.destructive)
                    Button("Retry") { startSave() }.disabled(!model.canSave || isSaving)
                }
            }
            if model.isLoading {
                LoadingIndicator(label: "Loading \(descriptor.singular)")
            }
            ForEach(model.sections) { section in
                let fields = section.fields.compactMap(descriptor.field).filter { renders($0) }
                if !fields.isEmpty {
                    Section(section.title) {
                        ForEach(fields, id: \.key) { field in
                            EntityFieldControl(field: field, model: model, pickedTitles: $pickedTitles)
                        }
                    }
                }
            }
            if descriptor.acceptsImages {
                if let suggestion = photoDaySuggestion(model) {
                    Section {
                        Button("Use photo date: \(suggestion.formatted(date: .abbreviated, time: .omitted))")
                        {
                            model.draft["observedOn"] = .string(PlainDate(suggestion).rawValue)
                        }
                    }
                }
                EntityImageBlock(
                    model: model, selections: $selections, uploadStatus: uploadStatus, disabled: isSaving)
            }
        }
        .formStyle(.grouped)
        .disabled(isSaving)
        .accessibilityIdentifier("editor.\(key.rawValue)")
    }

    /// Whether the field has a native control: everything but the image keys and the specialized
    /// renderers this file's doc comment lists.
    private func renders(_ field: FieldDescriptor) -> Bool {
        if Self.imageKeys.contains(field.key) { return false }
        guard field.controlKind == .specialized else { return true }
        guard let renderer = field.controlRenderer else { return false }
        switch NativePresentationCoverage.control(renderer) {
        case .implemented, .generic: return true
        case .ownedElsewhere, .unsupported: return false
        }
    }

    /// When the entity records an `observedOn` day and every picked photo was captured on one
    /// other day, offer that day (the garden journal's EXIF-date rule).
    private func photoDaySuggestion(_ model: GenericEntityEditModel) -> Date? {
        guard let field = descriptor.field("observedOn"), field.kind == .date, !model.readOnly("observedOn"),
            let first = selections.first?.capturedAt
        else { return nil }
        let calendar = Calendar.current
        guard
            selections.allSatisfy({ $0.capturedAt.map { calendar.isDate($0, inSameDayAs: first) } ?? false })
        else { return nil }
        let day = calendar.startOfDay(for: first)
        if let current = model.draft["observedOn"]?.stringValue, current == PlainDate(day).rawValue {
            return nil
        }
        return day
    }

    private func setup() async {
        guard model == nil else { return }
        let created = GenericEntityEditModel(
            descriptor: descriptor, mode: mode, client: appModel.client, original: original)
        model = created
        await created.load()
        initialDraft = created.draft
        seedPickedTitles(created)
    }

    /// Names the server projected beside reference ids (`<stem>Name` / `<stem>.name`), so an
    /// update editor opens showing names, not shortcodes.
    private func seedPickedTitles(_ model: GenericEntityEditModel) {
        guard let original = model.original else { return }
        for field in descriptor.fields where field.reference != nil {
            if let reference = EntityFieldValue.reference(in: original, field: field),
                let name = reference.name
            {
                pickedTitles[reference.id] = name
            }
        }
    }

    private func startSave() {
        guard saveTask == nil else { return }
        saveTask = Task {
            await save()
            saveTask = nil
        }
    }

    private func save() async {
        guard let model, model.canSave else { return }
        if !selections.isEmpty {
            isUploading = true
            defer { isUploading = false }
            do {
                try await uploadSelections(into: model)
            } catch is CancellationError {
                return
            } catch {
                uploadStatus = "Couldn't upload photos: \(error.localizedDescription)"
                Diagnostics.report(error, context: "editor.upload")
                return
            }
        }
        guard !Task.isCancelled, await model.save(), let id = model.savedID else { return }
        var keys: Set<EntityKey> = [key]
        for relation in descriptor.relations { keys.insert(relation.target) }
        appModel.recordEntityMutation(keys: keys)
        onSaved(id)
        guard !Task.isCancelled else { return }
        dismiss()
    }

    /// Uploads each picked photo once (an id a failed save already earned is reused) and hands
    /// the ids to the model as `pendingImageIds`.
    private func uploadSelections(into model: GenericEntityEditModel) async throws {
        let uploader = PendingImageUploader(entity: key, service: appModel.client)
        for index in selections.indices where selections[index].existingImageID == nil {
            try Task.checkCancellation()
            uploadStatus = "Uploading photo \(index + 1) of \(selections.count)…"
            let file = try await selections[index].materialize()
            guard let id = try await uploader.upload([file]).first else { continue }
            selections[index].existingImageID = id
        }
        uploadStatus = nil
        var seen: Set<ImageCode> = []
        model.pendingUploads = selections.compactMap(\.existingImageID).filter { seen.insert($0).inserted }
    }
}

#Preview("Create location") {
    EntityEditorSheet(key: .location, mode: .create(prefill: ["type": .string("area")])) { _ in }
        .environment(PreviewFixtures.signedInModel())
}

#Preview("Edit product") {
    EntityEditorSheet(
        key: .product, mode: .update(id: PreviewFixtures.sampleDetailRow.id),
        original: PreviewFixtures.sampleDetailRow.raw
    ) { _ in }
    .environment(PreviewFixtures.signedInModel())
}
