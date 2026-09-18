import CubbyKit
import SwiftUI

/// Stages a corrected count for one row. The unit is read-only — a recount corrects the quantity
/// counted, never the unit a product is tracked in, so there is no unit picker here.
struct AdjustCountSheet: View {
    let session: RecountSession
    let id: InventoryEntryCode
    let unit: String
    private let initialText: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft: AdjustmentQuantityDraft
    @State private var draftDismissal = DraftDismissalState()

    init(session: RecountSession, id: InventoryEntryCode, amount: Amount) {
        self.session = session
        self.id = id
        self.unit = amount.unit
        let draft = AdjustmentQuantityDraft(value: amount.value)
        initialText = draft.text
        // Presented via `.sheet(isPresented:)` at a fixed call site (`BinRowView`) — dismissing
        // tears the subtree down, so re-presenting rebuilds this seed fresh.
        _draft = State(initialValue: draft)  // state-init-ok
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: PorcelainTokens.Space.sm) {
                        TextField("Count", text: $draft.text)
                            .keyboardDismissBar()
                            #if os(iOS)
                                .keyboardType(.decimalPad)
                            #endif
                            .font(.porcelainData)
                            .accessibilityIdentifier("audit.adjust-count.amount")
                        Text(unit)
                            .font(.porcelainLabel)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                } header: {
                    Text("New count")
                } footer: {
                    if hasValidationError {
                        Label("Enter an amount greater than zero.", systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("audit.adjust-count.error")
                    }
                }
            }
            .navigationTitle("Adjust count")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        draftDismissal.request(isDirty: isDirty, dismiss: dismiss)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(draft.value == nil)
                        .accessibilityIdentifier("audit.adjust-count.save")
                }
            }
        }
        .nativeSheet(.adjustment)
        .draftDismissal($draftDismissal, isDirty: isDirty, isSaving: false) { dismiss() }
    }

    private func save() {
        guard let value = draft.value else { return }
        session.stage(.adjust(Amount(value: value, unit: unit)), for: id)
        dismiss()
    }

    private var isDirty: Bool { draft.text != initialText }

    private var hasValidationError: Bool {
        !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.value == nil
    }
}

#Preview("Adjust count") {
    @Previewable @State var appModel = PreviewFixtures.signedInModel()
    AdjustCountSheet(
        session: RecountSession(service: appModel.client),
        id: AuditPreviewData.sampleRow.id,
        amount: AuditPreviewData.sampleRow.amount
    )
}
