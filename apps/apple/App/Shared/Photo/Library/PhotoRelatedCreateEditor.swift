import CubbyKit
import SwiftUI

/// What the editor is producing: an existing source's related record (today's flow), a type's own
/// `createSelf` record (no source), or a chooser among the `createRelated` routes that target a
/// picked type (Garden entry ← Location/Planting, Meal ← Recipe) plus that type's own `createSelf`
/// route as a fallback when the user fills in no reference.
enum PhotoRelatedCreateEditorMode {
    case createRelated(option: PhotoDestinationOption, source: EntityRow)
    case createSelf(option: PhotoDestinationOption)
    case createTarget(
        descriptor: EntityDescriptor, candidates: [PhotoDestinationOption],
        fallback: PhotoDestinationOption?)
}

/// Stages a manifest-declared related record without calling the ordinary entity create endpoint.
/// The generic field controls still own validation and reference picking; the resulting body is
/// handed back to the import transaction so the record and its photos commit together.
struct PhotoRelatedCreateEditor: View {
    let mode: PhotoRelatedCreateEditorMode
    let captureDate: Date?
    let heroItems: [PhotoSelectionItem]
    let importManifest: PhotoImportManifest
    /// The chosen option, its source (`nil` for `createSelf`, or an unresolved `createTarget`),
    /// and the create body.
    let onDraft: (PhotoDestinationOption, EntityRow?, [String: JSONValue]) -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var model: GenericEntityEditModel?
    @State private var pickedTitles: [String: String] = [:]

    private var descriptor: EntityDescriptor {
        switch mode {
        case .createRelated(let option, _): option.descriptor
        case .createSelf(let option): option.descriptor
        case .createTarget(let descriptor, _, _): descriptor
        }
    }

    /// The known source record: only `createRelated` has one. `createSelf` has none by schema;
    /// `createTarget`'s reference is only a typed id (see `referenceFields`), not a resolved row.
    private var source: EntityRow? {
        if case .createRelated(_, let row) = mode { return row }
        return nil
    }

    /// Every binding across the mode's route(s), merged: `createTarget` prefills whichever
    /// constant/capture-date fields its candidates (and fallback) share, while leaving each
    /// candidate's own reference field open for the user (see `renders`).
    private var effectiveBindings: [PhotoCreateBinding] {
        switch mode {
        case .createRelated(let option, _): option.route.bindings
        case .createSelf(let option): option.route.bindings
        case .createTarget(_, let candidates, let fallback):
            candidates.flatMap(\.route.bindings) + (fallback?.route.bindings ?? [])
        }
    }

    /// `createTarget`'s reference fields: each candidate `createRelated` route's `source-id`
    /// binding field, paired with the route filling it in chooses. Sorted for determinism.
    private var referenceFields: [(field: String, option: PhotoDestinationOption)] {
        guard case .createTarget(_, let candidates, _) = mode else { return [] }
        return candidates.compactMap { option in
            option.route.bindings.first { $0.source == .sourceId }.map { ($0.field, option) }
        }.sorted { $0.field < $1.field }
    }

    private var referenceFieldHint: String {
        let labels = referenceFields.compactMap { descriptor.field($0.field)?.label }
        guard !labels.isEmpty else {
            return "Fill in a reference to create this \(descriptor.singular.lowercased())."
        }
        return
            "Fill in \(labels.joined(separator: " or ")) to create this \(descriptor.singular.lowercased())."
    }

    /// `createTarget`'s route, chosen by whichever reference field the user filled in, else the
    /// fallback `createSelf` route when none is filled; `nil` disables Continue.
    private func chosenTargetOption(in model: GenericEntityEditModel) -> PhotoDestinationOption? {
        guard case .createTarget(_, _, let fallback) = mode else { return nil }
        for (field, option) in referenceFields where model.draft[field]?.stringValue?.isEmpty == false {
            return option
        }
        return fallback
    }

    private func canSave(_ model: GenericEntityEditModel) -> Bool {
        guard model.canSave else { return false }
        if case .createTarget = mode { return chosenTargetOption(in: model) != nil }
        return true
    }

    /// A lightweight row for the reference the user typed/picked, good enough for `stageCreate`'s
    /// bookkeeping (title, id) — `createTarget` never loads the full referenced record.
    private func referenceRow(
        for option: PhotoDestinationOption, model: GenericEntityEditModel
    ) -> EntityRow? {
        guard let field = referenceFields.first(where: { $0.option.id == option.id })?.field,
            let id = model.draft[field]?.stringValue, !id.isEmpty
        else { return nil }
        return EntityRow(
            id: id, title: pickedTitles[field] ?? id, subtitle: nil, imageURL: nil,
            raw: .object([field: .string(id)]))
    }

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    VStack(spacing: 0) {
                        if !heroItems.isEmpty {
                            PhotoImportHero(items: heroItems)
                        }
                        PhotoAnalysisDisclosure(manifest: importManifest)
                        Form {
                            Section {
                                Label(
                                    "Continue to review. Nothing is added until you confirm the batch.",
                                    systemImage: "checkmark.shield"
                                )
                                .foregroundStyle(.secondary)
                            }
                            if case .createTarget = mode, chosenTargetOption(in: model) == nil {
                                Section {
                                    Label(referenceFieldHint, systemImage: "info.circle")
                                        .foregroundStyle(.secondary)
                                }
                            }
                            ForEach(model.sections) { section in
                                let fields = section.fields.compactMap(descriptor.field).filter(renders)
                                if !fields.isEmpty {
                                    Section(section.title) {
                                        ForEach(fields, id: \.key) { field in
                                            EntityFieldControl(
                                                field: field, model: model, pickedTitles: $pickedTitles)
                                        }
                                    }
                                }
                            }
                        }
                        .formStyle(.grouped)
                    }
                } else {
                    LoadingIndicator.screen(label: "Preparing \(descriptor.singular)")
                }
            }
            .navigationTitle("New \(descriptor.singular)")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Continue") {
                        guard let model, canSave(model) else { return }
                        switch mode {
                        case .createRelated(let option, let row):
                            onDraft(option, row, model.createBody())
                        case .createSelf(let option):
                            onDraft(option, nil, model.createBody())
                        case .createTarget:
                            guard let chosen = chosenTargetOption(in: model) else { return }
                            onDraft(chosen, referenceRow(for: chosen, model: model), model.createBody())
                        }
                        dismiss()
                    }
                    .disabled(!(model.map(canSave) ?? false))
                    .accessibilityIdentifier("photos.destination.create.continue")
                }
            }
        }
        .nativeSheet(.editor)
        .task {
            guard model == nil else { return }
            let created = GenericEntityEditModel(
                descriptor: descriptor,
                mode: .create(prefill: createPrefill()),
                client: appModel.client,
                suppressDefaultKeys: captureDateBoundKeys)
            model = created
        }
    }

    private func renders(_ field: FieldDescriptor) -> Bool {
        Self.renders(field, bindings: effectiveBindings, source: source, captureDate: captureDate)
    }

    /// Whether the create form would show `field` at all: hidden when a manifest binding already
    /// supplies its value from a *known* record. `source-id`/`relation-items` hide only when a
    /// real source row is known (`createRelated`) — `createSelf` never has such bindings by schema,
    /// and `createTarget`'s reference is only a typed id, so those fields stay open for the user to
    /// fill in directly. Shared with `PhotoImportManifest.chooseSourceRecord`'s auto-resolve, which
    /// needs the full create form's rendered-field roster without instantiating this editor.
    static func renders(
        _ field: FieldDescriptor, bindings: [PhotoCreateBinding], source: EntityRow?,
        captureDate: Date?
    ) -> Bool {
        // TODO: derive from image-policy.gen.ts
        if ["pendingImageIds", "removeImageIds", "imageOrder"].contains(field.key) { return false }
        for binding in bindings where binding.field == field.key {
            switch binding.source {
            case .sourceField:
                if let source,
                    PhotoImportManifest.nonNullSourceFieldValue(binding: binding, source: source) != nil
                {
                    return false
                }
            case .captureDate:
                if captureDate != nil { return false }
            case .constant:
                return false
            case .sourceId, .relationItems:
                if source != nil { return false }
            }
        }
        guard field.controlKind == .specialized else { return true }
        return field.reference != nil || field.format == "amount" || field.kind == .textArray
    }

    private func createPrefill() -> [String: JSONValue] {
        Self.createPrefill(bindings: effectiveBindings, source: source, captureDate: captureDate)
    }

    /// Fields a `capture-date` binding controls (A1): when `captureDate` is nil, `createPrefill`
    /// leaves these unset and the field must come up genuinely empty, never silently defaulted
    /// to today via `FieldDescriptor.initial` — the person must supply a real date.
    private var captureDateBoundKeys: Set<String> {
        Set(effectiveBindings.filter { $0.source == .captureDate }.map(\.field))
    }

    static func createPrefill(
        bindings: [PhotoCreateBinding], source: EntityRow?, captureDate: Date?
    ) -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        for binding in bindings {
            switch binding.source {
            case .sourceId:
                guard let source else { continue }
                result[binding.field] =
                    binding.itemField != nil ? .array([.string(source.id)]) : .string(source.id)
            case .sourceField:
                guard let source,
                    let value = PhotoImportManifest.nonNullSourceFieldValue(
                        binding: binding, source: source)
                else { continue }
                result[binding.field] = value
            case .captureDate:
                if let captureDate {
                    result[binding.field] = .string(PlainDate(captureDate).rawValue)
                }
            case .constant:
                if let json = binding.constantJSON,
                    let data = json.data(using: .utf8),
                    let value = try? JSONDecoder().decode(JSONValue.self, from: data)
                {
                    result[binding.field] = value
                }
            case .relationItems:
                guard let source, let itemField = binding.itemField else { continue }
                result[binding.field] = .array([.object([itemField: .string(source.id)])])
            }
        }
        return result
    }

    static func createPrefill(
        option: PhotoDestinationOption, source: EntityRow?, captureDate: Date?
    ) -> [String: JSONValue] {
        createPrefill(bindings: option.route.bindings, source: source, captureDate: captureDate)
    }

    /// True when every field the create form would show (`renders`) is optional — nullable or
    /// seeded with a default (`initial`). `chooseSourceRecord`'s auto-resolve (and the "New
    /// <entity>" row's `createSelf` case) stages such a create directly instead of opening this
    /// editor for fields a person would just accept. Not used for `createTarget`, which always
    /// opens the editor — the reference choice needs a person regardless.
    static func hasOnlyOptionalFields(
        option: PhotoDestinationOption, source: EntityRow?, captureDate: Date?
    ) -> Bool {
        let bindings = option.route.bindings
        return option.descriptor.fields
            .filter { $0.controlKind != nil && $0.inCreate }
            .filter { renders($0, bindings: bindings, source: source, captureDate: captureDate) }
            .allSatisfy { field in
                // A capture-date-bound field renders (i.e. shows in the form) only when there is
                // no capture date to prefill it with (A1) — that field is never "optional" just
                // because its schema default is `initial: "today"`; it needs a real photo date.
                if captureDate == nil,
                    bindings.contains(where: { $0.field == field.key && $0.source == .captureDate })
                {
                    return false
                }
                return field.nullable || field.initial != nil
            }
    }
}
