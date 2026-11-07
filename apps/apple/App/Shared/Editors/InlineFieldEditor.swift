import CubbyKit
import SwiftUI

extension FieldDescriptor {
    /// A simple scalar detail edits in place: text, number, money, one option, a date, a toggle
    /// or one reference. Structured, collection, multi-line and range fields keep the editor sheet
    /// (or their web handoff); `display.inlineEdit: false` opts a field out.
    func editsInline(on entity: EntityKey) -> Bool {
        guard inUpdate, inlineEdit != false, valueSchema == nil, collection == nil,
            entity.nativeActions.contains(.update),
            NativePresentationCoverage.controlHandoff(self, entity: entity) == nil
        else { return false }
        switch controlKind {
        case .text, .number, .checkbox, .select, .date:
            return true
        case .specialized:
            guard let renderer = controlRenderer, let drawing = EntityFieldControl.drawing(for: renderer)
            else {
                return false
            }
            switch drawing {
            case .entityReference: return reference?.multiple != true
            case .money, .text: return true
            case .entityMultiReference, .amount, .tokens, .productTags, .ledgerAttributions: return false
            }
        case .textarea, .dateRange, nil:
            return false
        }
    }
}

extension EnvironmentValues {
    /// Record details edit simple fields in place; other hosts of `FieldsSectionView` stay read-only.
    @Entry var detailInlineEdit = false
}

/// One field's in-place edit: an update editor model scoped to the record, so Save sends a
/// single-field patch (`EntityPatch.diff`) through the ordinary update path with the editor's own
/// validation, envelope controls and Why this value. The presenter builds it when editing starts.
@MainActor
final class InlineEditSession: Identifiable {
    let field: FieldDescriptor
    let model: GenericEntityEditModel
    var id: String { field.key }

    init(field: FieldDescriptor, row: EntityRow, descriptor: EntityDescriptor, client: CubbyClient) {
        self.field = field
        model = GenericEntityEditModel(
            descriptor: descriptor, mode: .update(id: row.id), client: client, original: row.raw)
    }
}

/// The control for one field with Cancel and Save, drawn where the field's row stood (or in a
/// compact sheet for an action-bar quick field). Server validation renders under the control.
struct InlineFieldEditor: View {
    let session: InlineEditSession
    var inSheet = false
    let onFinished: () -> Void

    @Environment(AppModel.self) private var appModel
    @State private var pickedTitles: [String: String] = [:]
    @State private var saveTask: Task<Void, Never>?

    private var model: GenericEntityEditModel { session.model }
    private var accessibilityID: String {
        "detail.\(model.descriptor.key.rawValue).\(session.field.key).inline"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            EntityFieldControl(field: session.field, model: model, pickedTitles: $pickedTitles)
                .disabled(model.isLoading || model.isSaving)
                .onSubmit { save() }
            if let message = model.loadError ?? model.bannerError {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(FieldGuideTokens.destructive)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("\(accessibilityID).error")
            }
            if !inSheet {
                HStack(spacing: FieldGuideTokens.Space.md) {
                    Spacer(minLength: 0)
                    Button("Cancel", action: cancel)
                        .buttonStyle(.borderless)
                        .keyboardShortcut(.cancelAction)
                        .disabled(model.isSaving)
                        .frame(minHeight: FieldGuideTokens.touchTarget)
                    saveButton.buttonStyle(.borderedProminent)
                }
            }
        }
        .toolbar {
            if inSheet {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel).disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) { saveButton }
            }
        }
        .accessibilityIdentifier(accessibilityID)
        // A detail read is only the first presentation; the edit baseline is a fresh read.
        .task(id: session.id) { await model.load() }
        .onDisappear { saveTask?.cancel() }
    }

    private var saveButton: some View {
        Button {
            save()
        } label: {
            if model.isSaving { ProgressView { Text("Saving…") } } else { Text("Save") }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(!model.canSave)
        .accessibilityIdentifier("\(accessibilityID).save")
    }

    private func cancel() {
        saveTask?.cancel()
        onFinished()
    }

    private func save() {
        guard saveTask == nil, model.canSave else { return }
        saveTask = Task {
            defer { saveTask = nil }
            guard await model.save(), !Task.isCancelled else { return }
            var keys: Set<EntityKey> = [model.descriptor.key]
            for relation in model.descriptor.relations { keys.insert(relation.target) }
            appModel.recordEntityMutation(keys: keys)
            onFinished()
        }
    }
}

/// An action-bar quick field: the same in-place editor in a compact sheet, because the field may
/// live in the summary grid rather than a section row.
struct InlineFieldEditorSheet: View {
    let session: InlineEditSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                InlineFieldEditor(session: session, inSheet: true) { dismiss() }
            }
            .navigationTitle(session.field.label)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
        }
        .presentationDetents([.medium, .large])
    }
}

#Preview("Inline field editor") {
    let model = PreviewFixtures.signedInModel()
    let descriptor = EntityCatalog[.product]
    let field = descriptor.fields.first { $0.editsInline(on: .product) && $0.controlKind == .text }!
    List {
        InlineFieldEditor(
            session: InlineEditSession(
                field: field, row: PreviewFixtures.sampleDetailRow, descriptor: descriptor,
                client: model.client)
        ) {}
    }
    .environment(model)
}
