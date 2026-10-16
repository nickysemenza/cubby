import CubbyKit
import SwiftUI

struct PhotoGroupOwnershipEditView: View {
    let runID: String
    let group: PhotoGroupProposal
    let saved: () -> Void

    @Environment(AppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var stockIntent = "evidence"
    @State private var quantity = 1
    @State private var locationID: String?
    @State private var locationName = "Choose a location"
    @State private var choosingLocation = false
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                Picker("Own it now?", selection: $stockIntent) {
                    Text("Reference only").tag("evidence")
                    Text("Already counted · no stock change").tag("counted")
                    Text("Historical · no stock change").tag("historical")
                    Text("Yes · receive into inventory").tag("receive")
                }
                if stockIntent == "receive" {
                    Stepper("Quantity: \(quantity)", value: $quantity, in: 1...Int.max)
                    Button {
                        choosingLocation = true
                    } label: {
                        Text(locationName).frame(minHeight: 44).contentShape(.rect)
                    }
                } else {
                    Text("No inventory change").foregroundStyle(.secondary)
                }
            } footer: {
                Text("This saves the review answer. Inventory changes only when you apply the group.")
            }
            if let error { ActionFailureNotice(message: error) }
        }
        .navigationTitle("Own it now?")
        .disabled(saving)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save answer") { Task { await save() } }
                    .disabled(saving || (stockIntent == "receive" && locationID == nil))
            }
        }
        .task(id: group.updatedAt) {
            stockIntent =
                group.review?.stockIntent.rawValue ?? (group.inventory == nil ? "evidence" : "receive")
            quantity = group.inventory?.quantity ?? 1
            locationID = group.inventory?.locationId?.rawValue
            locationName = group.inventory?.locationName ?? "Choose a location"
        }
        .sheet(isPresented: $choosingLocation) {
            EntityPickerSheet(target: .location, selected: [locationID].compactMap { $0 }) { picks in
                guard let location = picks.first else { return }
                locationID = location.id
                locationName = location.title
            }
        }
    }

    private func save() async {
        saving = true
        error = nil
        defer { saving = false }
        do {
            let edit = try PhotoReviewEdits.ownership(
                group: group, locationID: stockIntent == "receive" ? locationID : nil, quantity: quantity,
                stockIntent: stockIntent)
            _ = try await appModel.client.savePhotoGroups(runID: runID, groups: [edit])
            saved()
            dismiss()
        } catch {
            Diagnostics.report(error, context: "Save photo ownership")
            self.error = error.localizedDescription
        }
    }
}

#if DEBUG
    #Preview("Photo ownership", traits: .modifier(SignedInPreview())) {
        if let group = RunReviewPreviewFixture.model().review?.review.proposals.first {
            NavigationStack {
                PhotoGroupOwnershipEditView(runID: RunReviewPreviewFixture.runID, group: group, saved: {})
            }
        }
    }
#endif
