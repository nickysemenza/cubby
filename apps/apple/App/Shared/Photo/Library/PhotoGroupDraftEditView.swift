import CubbyKit
import SwiftUI

/// Edits the Product a photo group proposes to create, before the group is approved.
struct PhotoGroupDraftEditView: View {
    let runID: String
    let group: PhotoGroupProposal
    let onSaved: () -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var manufacturer = ""
    @State private var modelName = ""
    @State private var notes = ""
    @State private var categoryID: String?
    @State private var categoryName: String?
    @State private var choosingCategory = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        Form {
            Section("Product") {
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    Text("Name").font(.caption).foregroundStyle(.secondary)
                    TextField("Product name", text: $name)
                }
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    Text("Manufacturer").font(.caption).foregroundStyle(.secondary)
                    TextField("Manufacturer", text: $manufacturer)
                }
                VStack(alignment: .leading, spacing: FieldGuideTokens.Space.xs) {
                    Text("Model").font(.caption).foregroundStyle(.secondary)
                    TextField("Model", text: $modelName)
                }
                Button {
                    choosingCategory = true
                } label: {
                    LabeledContent("Category", value: categoryName ?? categoryID ?? "Choose category")
                }
                if categoryID != nil {
                    Button("Clear category") {
                        categoryID = nil
                        categoryName = nil
                    }
                }
            }
            Section("Product notes") {
                TextField("Product details", text: $notes, axis: .vertical)
                    .lineLimit(2...5)
            }
            if let error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(FieldGuideTokens.destructive)
                }
            }
        }
        .navigationTitle("Edit product proposal")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { Task { await save() } }
                    .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .task(id: group.groupKey) {
            guard case .create(let product) = group.product else { return }
            name = product.create.name
            manufacturer = product.create.manufacturer ?? ""
            modelName = product.create.model ?? ""
            notes = product.create.notes ?? ""
            categoryID = product.create.categoryId
        }
        .sheet(isPresented: $choosingCategory) {
            EntityPickerSheet(
                target: .productCategory, selected: [categoryID].compactMap { $0 }
            ) { picks in
                guard let category = picks.first else { return }
                categoryID = category.id
                categoryName = category.title
            }
        }
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        error = nil
        defer { saving = false }
        do {
            _ = try await appModel.client.updatePhotoGroupDraft(
                .init(
                    runId: runID,
                    groupKey: group.groupKey,
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                    categoryId: categoryID,
                    manufacturer: manufacturer.isEmpty ? nil : manufacturer,
                    model: modelName.isEmpty ? nil : modelName,
                    notes: notes.isEmpty ? nil : notes))
            onSaved()
            dismiss()
        } catch {
            Diagnostics.report(error, context: "Edit photo group product proposal")
            self.error = error.localizedDescription
        }
    }
}

#if DEBUG
    #Preview("Edit product proposal", traits: .modifier(SignedInPreview())) {
        if let group = RunReviewPreviewFixture.model().review?.review.proposals.first {
            NavigationStack {
                PhotoGroupDraftEditView(runID: RunReviewPreviewFixture.runID, group: group) {}
            }
        }
    }
#endif
