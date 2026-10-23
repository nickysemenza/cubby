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
    @State private var brandID: String?
    @State private var brandName: String?
    @State private var choosingBrand = false
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
                LabeledContent("Name") {
                    TextField("Name", text: $name, prompt: Text("None"))
                        .multilineTextAlignment(.trailing)
                        .labelsHidden()
                }
                Button {
                    choosingBrand = true
                } label: {
                    LabeledContent("Brand", value: brandName ?? brandID ?? "Choose brand")
                }
                if brandID != nil {
                    Button("Clear brand") {
                        brandID = nil
                        brandName = nil
                    }
                }
                LabeledContent("Model") {
                    TextField("Model", text: $modelName, prompt: Text("None"))
                        .multilineTextAlignment(.trailing)
                        .labelsHidden()
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
                Button("Save proposal") { Task { await save() } }
                    .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .task(id: group.groupKey) {
            guard case .create(let product) = group.product else { return }
            name = product.create.name
            brandID = product.create.brandId
            brandName = nil
            modelName = product.create.model ?? ""
            notes = product.create.notes ?? ""
            categoryID = product.create.categoryId
            if let selectedBrandID = brandID {
                do {
                    let brand = try await appModel.client.row(EntityCatalog[.vendor], id: selectedBrandID)
                    guard !Task.isCancelled, brandID == selectedBrandID else { return }
                    brandName = brand?.title
                } catch {
                    guard !Task.isCancelled else { return }
                    Diagnostics.report(error, context: "Load photo proposal brand")
                    self.error = error.localizedDescription
                }
            }
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
        .sheet(isPresented: $choosingBrand) {
            EntityPickerSheet(
                target: .vendor, selected: [brandID].compactMap { $0 }
            ) { picks in
                guard let brand = picks.first else { return }
                brandID = brand.id
                brandName = brand.title
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
                .object([
                    "runId": .string(runID),
                    "groupKey": .string(group.groupKey),
                    "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                    "categoryId": categoryID.map(JSONValue.string) ?? .null,
                    "brandId": brandID.map(JSONValue.string) ?? .null,
                    "model": modelName.isEmpty ? .null : .string(modelName),
                    "notes": notes.isEmpty ? .null : .string(notes),
                ]))
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
