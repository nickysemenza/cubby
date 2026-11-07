import CubbyKit
import SwiftUI

/// Bulk edit for a selection, mirroring web's: choose one field, then Set value with the record
/// editor's own control or Clear it; a text list or multi-reference adds and removes items with
/// that same control, and a keyed structured collection opens web's bulk edit. One atomic kernel
/// bulk update carries the change; a refusal shows the raw diagnostic above the preserved choice
/// and the selection is kept.
struct EntityBulkEditSheet: View {
    @Bindable var model: EntityBulkEditModel
    let onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var pickedTitles: [String: String] = [:]

    private var noun: String {
        model.ids.count == 1 ? model.descriptor.singular.lowercased() : model.descriptor.plural.lowercased()
    }

    var body: some View {
        NavigationStack {
            Form {
                if let failure = model.failure {
                    Section {
                        ActionFailureNotice(title: "Couldn't update", message: failure, canRetry: false)
                    }
                }
                Section {
                    Picker("Field", selection: $model.fieldKey) {
                        Text("Choose…").tag(String?.none)
                        ForEach(model.fields, id: \.key) { field in
                            Text(field.label).tag(Optional(field.key))
                        }
                    }
                    .accessibilityIdentifier("bulkEdit.field")
                    if model.canClear {
                        Picker("Change", selection: $model.mode) {
                            Text("Set value").tag(EntityBulkEditModel.Mode.set)
                            Text(model.field?.resolution?.labels?.none ?? "Clear").tag(
                                EntityBulkEditModel.Mode.clear)
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("bulkEdit.mode")
                    }
                } footer: {
                    Text(
                        "Changes \(model.ids.count.formatted()) \(noun) together. If any can't take the value, none change."
                    )
                }
                if let field = model.field {
                    switch model.assignment {
                    case .value?:
                        if model.mode == .set {
                            Section {
                                EntityFieldControl(
                                    field: field, model: model.draft, pickedTitles: $pickedTitles)
                            }
                        }
                    case .addRemove?:
                        Section("Add") {
                            EntityFieldControl(field: field, model: model.draft, pickedTitles: $pickedTitles)
                        }
                        .accessibilityIdentifier("bulkEdit.add")
                        Section {
                            EntityFieldControl(
                                field: field, model: model.removeDraft, pickedTitles: $pickedTitles)
                        } header: {
                            Text("Remove")
                        } footer: {
                            Text("Each record keeps its other \(field.label.lowercased()).")
                        }
                        .accessibilityIdentifier("bulkEdit.remove")
                    case .web?:
                        Section {
                            OpenOnWebButton(
                                target: .route(path: "/\(model.descriptor.basePath)"),
                                label: "Bulk edit on web")
                        } footer: {
                            Text(
                                "\(field.label) entries are added and removed one by one in web's bulk edit.")
                        }
                        .accessibilityIdentifier("bulkEdit.web")
                    case nil:
                        EmptyView()
                    }
                }
                if let validation = model.validation {
                    Section {
                        Text(validation)
                            .font(.footnote)
                            .foregroundStyle(FieldGuideTokens.destructive)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Bulk edit")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Update \(model.ids.count.formatted())") {
                        Task {
                            if await model.save() != nil {
                                onFinished()
                                dismiss()
                            }
                        }
                    }
                    .disabled(!model.canSave)
                    .accessibilityIdentifier("bulkEdit.save")
                }
            }
            .interactiveDismissDisabled(model.isSaving)
        }
        #if os(macOS)
            .frame(minWidth: 420, minHeight: 320)
        #endif
    }
}

#Preview("Bulk edit", traits: .modifier(SignedInPreview())) {
    @Previewable @Environment(AppModel.self) var appModel
    EntityBulkEditSheet(
        model: EntityBulkEditModel(
            descriptor: EntityCatalog[.task], ids: ["TSK-2345", "TSK-3456"], client: appModel.client)
    ) {}
}
