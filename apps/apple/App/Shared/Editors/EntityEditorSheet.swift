import CubbyKit
import SwiftUI

/// Generic create/update fields follow the catalog's editor sections. Native structured controls
/// edit identifiers, aliases, source references, unit mappings and label nutrition; structured-field
/// editors retain a read-only summary and a named web handoff. Required web-only fields keep create
/// on web. DraftDismissalState and inline validation preserve edits until Save or explicit discard.
/// One field's resolution link a detail screen asks the editor to stage.
struct ResolutionActionRequest: Hashable, Identifiable {
    let field: String
    let kind: FieldResolutionAction.Kind
    var id: String { "\(field):\(kind.rawValue)" }
}

struct EntityEditorSheet: View {
    let key: EntityKey
    let mode: GenericEntityEditModel.Mode
    /// The loaded record for an update editor opened from a detail screen (skips the fetch).
    var original: JSONValue? = nil
    /// A detail resolution link (Use inherited, Confirm, Set to …) staged for review; Save
    /// remains the only write.
    var resolutionAction: ResolutionActionRequest? = nil
    /// Values a detail action derived (a detected nutrition panel) staged for review as the
    /// person's own edits; Save remains the only write.
    var stagedValues: [String: JSONValue] = [:]
    /// A create the hero action opened with its own title and guidance (record sale).
    var context: HeroEditorContext? = nil
    let onSaved: (String) -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var model: GenericEntityEditModel?
    @State private var suggestions: FieldSuggestionReviewModel?
    @State private var initializedIdentity: EditorIdentity?
    @State private var selections: [PhotoSelectionItem] = []
    @State private var pickedTitles: [String: String] = [:]
    @State private var uploadStatus: String?
    @State private var suggestionFeedbackError: String?
    @State private var isUploading = false
    @State private var draftDismissal = DraftDismissalState()
    @State private var allowsDismissal = false
    @State private var saveTask: Task<Void, Never>?

    private struct EditorIdentity: Hashable {
        let key: EntityKey
        let mode: GenericEntityEditModel.Mode
        let resolutionAction: ResolutionActionRequest?
    }

    private var descriptor: EntityDescriptor { EntityCatalog[key] }
    private var editorIdentity: EditorIdentity {
        EditorIdentity(key: key, mode: mode, resolutionAction: resolutionAction)
    }

    private var isCreate: Bool {
        if case .create = mode { return true }
        return false
    }

    private var handoffFields: [FieldDescriptor] {
        descriptor.fields.filter { field in
            let participates = isCreate ? field.inCreate : field.inUpdate
            return participates && NativePresentationCoverage.controlHandoff(field, entity: key) != nil
        }
    }

    private var handoffRequiredFields: [FieldDescriptor] {
        guard isCreate else { return [] }
        return handoffFields.filter(\.requiredOnCreate)
    }

    /// Keys the photo block owns; they never render as field controls. Derived from
    /// `image-policy.gen.ts`'s `updateInputImages` (see `PhotoImportCatalog.imageFieldKeys`)
    /// so this can't drift from the wire schema's own list.
    private static let imageKeys = PhotoImportCatalog.imageFieldKeys

    var body: some View {
        NavigationStack {
            Group {
                if let model, let failure = loadFailure(model) {
                    // A failed update read is not a refused save: offer a load retry.
                    LoadFailureView(title: "Couldn't load \(descriptor.singular)", message: failure) {
                        await retryLoad(model)
                    }
                } else if let model {
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
                    Button("Cancel") {
                        draftDismissal.request(isDirty: isDirty, isSaving: isSaving, dismiss: dismiss)
                    }
                    .keyboardShortcut(.cancelAction)
                    .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { startSave() }
                        .disabled(
                            !(model?.canSave ?? false) || !handoffRequiredFields.isEmpty || isSaving
                        )
                        .accessibilityIdentifier("editor.\(key.rawValue).save")
                }
            }
        }
        .nativeSheet(.editor)
        .draftDismissal(
            $draftDismissal, isDirty: isDirty && !allowsDismissal, isSaving: isSaving,
            title: "Discard changes?", confirmInteractiveDismissal: true,
            onDiscard: { allowsDismissal = true }
        )
        .onChange(of: allowsDismissal) { _, allowed in
            if allowed { dismiss() }
        }
        .onDisappear {
            saveTask?.cancel()
            suggestions?.invalidate()
        }
        .task(id: editorIdentity) { await setup() }
    }

    /// The update read failed. A supplied detail projection may still seed the form, but it is
    /// not an edit baseline, so the sheet offers a read retry instead of the form.
    private func loadFailure(_ model: GenericEntityEditModel) -> String? {
        model.isLoading ? nil : model.loadError
    }

    private var title: String {
        if let context { return context.title }
        switch mode {
        case .create: return "New \(descriptor.singular)"
        case .update: return "Edit \(descriptor.singular)"
        }
    }

    private var isSaving: Bool {
        isUploading || (model?.isSaving ?? false) || (suggestions?.isApplying ?? false)
    }

    private var isDirty: Bool {
        guard let model else { return false }
        return model.isDirty || !selections.isEmpty
    }

    private static let saveFailureID = "editor.saveFailure"

    private func form(_ model: GenericEntityEditModel) -> some View {
        ScrollViewReader { proxy in
            formContent(model)
                // Save lives in the toolbar, so a refusal can arrive while the banner is
                // scrolled out of view above the field being edited.
                .onChange(of: saveFailure(model)) { _, banner in
                    guard banner != nil else { return }
                    proxy.scrollTo(Self.saveFailureID, anchor: .top)
                }
                .onChange(of: model.fieldErrors) { _, _ in scrollToInvalidField(model, proxy: proxy) }
                .onChange(of: model.nestedErrors) { _, _ in scrollToInvalidField(model, proxy: proxy) }
        }
    }

    private func scrollToInvalidField(_ model: GenericEntityEditModel, proxy: ScrollViewProxy) {
        guard saveFailure(model) == nil,
            let field = model.visibleFields.first(where: {
                renders($0) && (model.fieldErrors[$0.key] != nil || model.nestedErrors[$0.key] != nil)
            })
        else { return }
        proxy.scrollTo(field.key, anchor: .center)
    }

    /// Validation for an image key or web-only control has no input row here. Keep it visible
    /// with non-field failures, without duplicating errors that the native controls draw inline.
    private func saveFailure(_ model: GenericEntityEditModel) -> String? {
        let hiddenErrors = model.visibleFields.filter { !renders($0) }.flatMap { field in
            let fieldError = model.fieldErrors[field.key].map { "\(field.label): \($0)" }
            let nested = (model.nestedErrors[field.key] ?? [:])
                .sorted { $0.key.lexicographicallyPrecedes($1.key) }
                .map { "\(field.label).\($0.key.joined(separator: ".")): \($0.value)" }
            return [fieldError].compactMap { $0 } + nested
        }
        let messages = [model.bannerError].compactMap { $0 } + hiddenErrors
        return messages.isEmpty ? nil : messages.joined(separator: "\n")
    }

    private func formContent(_ model: GenericEntityEditModel) -> some View {
        Form {
            if let suggestionFeedbackError {
                Text(suggestionFeedbackError)
                    .foregroundStyle(FieldGuideTokens.destructive)
                    .accessibilityIdentifier("editor.suggestions.feedback-error")
            }
            if let context {
                Section { Text(context.description).foregroundStyle(.secondary) }
            }
            if !handoffRequiredFields.isEmpty {
                Section {
                    Text("This record needs additional fields available on web to create it.")
                        .foregroundStyle(.secondary)
                }
            }
            if let banner = saveFailure(model) {
                Section {
                    ActionFailureNotice(message: banner, canRetry: model.canSave && !isSaving) {
                        startSave()
                    }
                }
                .id(Self.saveFailureID)
            }
            if model.isLoading {
                LoadingIndicator(label: "Loading \(descriptor.singular)")
            }
            ForEach(model.sections) { section in
                let fields = section.fields.compactMap(descriptor.field).filter {
                    renders($0) || NativePresentationCoverage.controlHandoff($0, entity: key) != nil
                }
                if !fields.isEmpty {
                    if let title = section.title {
                        Section(title) {
                            ForEach(fields, id: \.key) { field in
                                editorField(field, model: model)
                                    .id(field.key)
                            }
                        }
                    } else {
                        ForEach(fields, id: \.key) { field in
                            editorField(field, model: model)
                                .id(field.key)
                        }
                    }
                }
            }
            if let suggestions, !suggestions.fields.isEmpty {
                EntityFieldSuggestionSection(review: suggestions, pickedTitles: pickedTitles) {
                    _, value, label in
                    if let id = value.stringValue, let label { pickedTitles[id] = label }
                    appModel.recordEntityMutation(keys: [
                        key, .financialTransaction, .purchase, .expense, .product,
                    ])
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
        .keyboardDismissBar()
        .disabled(isSaving || model.isLoading)
        .accessibilityIdentifier("editor.\(key.rawValue)")
    }

    @ViewBuilder
    private func editorField(_ field: FieldDescriptor, model: GenericEntityEditModel) -> some View {
        if let handoff = NativePresentationCoverage.controlHandoff(field, entity: key) {
            let raw = model.original ?? .object(model.draft)
            let value = raw[field.key]
            let summary =
                EntityFieldValue.text(in: raw, field: field, surface: "detail")
                ?? EntityFieldValue.text(value, field: field)
                ?? (value == nil || value == .null || value?.arrayValue?.isEmpty == true
                    ? "None" : "Value saved")
            LabeledContent(field.label) {
                Text(summary).foregroundStyle(.secondary).textSelection(.enabled)
            }
            OpenOnWebButton(
                target: model.recordID.map { handoff.target(key: key, id: $0) }
                    ?? .route(path: "/\(descriptor.basePath)/new"),
                label: handoff.label
            )
            .accessibilityIdentifier("editor.\(key.rawValue).\(field.key).openOnWeb")
        } else {
            EntityFieldControl(field: field, model: model, pickedTitles: $pickedTitles)
        }
    }

    /// Image keys belong to the photo block; web-only fields have summaries rather than inputs.
    private func renders(_ field: FieldDescriptor) -> Bool {
        if Self.imageKeys.contains(field.key)
            || NativePresentationCoverage.controlHandoff(field, entity: key) != nil
        {
            return false
        }
        guard field.controlKind == .specialized else { return true }
        guard let renderer = field.controlRenderer else { return false }
        switch NativePresentationCoverage.control(renderer) {
        case .implemented, .generic: return true
        case .ownedElsewhere, .handoff: return false
        }
    }

    /// When the entity records an `observedOn` day and every picked photo was captured on one
    /// other day, offer that day (the garden journal's EXIF-date rule).
    private func photoDaySuggestion(_ model: GenericEntityEditModel) -> Date? {
        guard let field = descriptor.field("observedOn"), field.kind == .date,
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
        if initializedIdentity == editorIdentity, let model {
            suggestions = suggestionReview(for: model)
            return
        }
        suggestions?.invalidate()
        initializedIdentity = editorIdentity
        selections = []
        allowsDismissal = false
        pickedTitles = [:]
        let identity = editorIdentity
        let created = GenericEntityEditModel(
            descriptor: descriptor, mode: mode, client: appModel.client, original: original)
        model = created
        await created.load()
        finishLoad(created, identity: identity)
    }

    /// Retries a failed update read. The sheet's identity is unchanged, so `.task(id:)` won't
    /// rerun setup; the retry must re-baseline the draft itself or the untouched editor reads
    /// as dirty.
    private func retryLoad(_ model: GenericEntityEditModel) async {
        let identity = editorIdentity
        await model.load()
        finishLoad(model, identity: identity)
    }

    /// Applies staged values after the model has baselined its loaded draft.
    private func finishLoad(_ loaded: GenericEntityEditModel, identity: EditorIdentity) {
        guard !Task.isCancelled, initializedIdentity == identity, model === loaded else { return }
        if let resolutionAction { loaded.stageResolution(resolutionAction.kind, for: resolutionAction.field) }
        loaded.stage(stagedValues)
        seedPickedTitles(loaded)
        suggestions?.invalidate()
        suggestions = suggestionReview(for: loaded)
    }

    private func suggestionReview(for model: GenericEntityEditModel) -> FieldSuggestionReviewModel {
        let client = appModel.client
        return FieldSuggestionReviewModel(
            editor: model, fetch: { try await client.suggestFieldsReview($0) },
            saveCategory: { try await client.applyFinanceCategorySuggestion($0) },
            reviewAssessment: { try await client.reviewAssessment($0) })
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
        guard let model, model.canSave, handoffRequiredFields.isEmpty else { return }
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
        do {
            try await suggestions?.recordSavedApplications(recordId: id)
            suggestionFeedbackError = nil
        } catch {
            suggestionFeedbackError =
                "Saved, but suggestion feedback could not be recorded: \(error.localizedDescription)"
            Diagnostics.report(error, context: "editor.suggestion-feedback")
            return
        }
        onSaved(id)
        guard !Task.isCancelled else { return }
        allowsDismissal = true
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

#Preview("Edit project") {
    let raw: JSONValue = [
        "id": "PRJ-4K7M", "name": "Backyard deck refresh", "status": "planning", "emoji": "🪵",
        "locations": ["Back deck"], "costEstimate": 450,
        "assignee": ["id": "LPY-2B9C", "name": "Alex"],
        "fieldResolutions": [
            "assigneeId": [
                "mode": "inherit", "storedValue": .null, "value": "LPY-2B9C", "fallbackValue": "LPY-2B9C",
                "source": "parent project",
                "sourceEntity": ["entityKind": "project", "entityId": "PRJ-9Q3R", "name": "Yard upkeep"],
                "matchesFallback": false, "canReset": false,
            ]
        ],
    ]
    EntityEditorSheet(key: .project, mode: .update(id: "PRJ-4K7M"), original: raw) { _ in }
        .environment(PreviewFixtures.signedInModel())
}
