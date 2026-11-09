import CubbyKit
import SwiftUI

/// Stages a corrected count for one row; the bin's Done commits it with the rest of the bin. The
/// unit is read-only — a recount corrects the quantity counted, never the unit a product is
/// tracked in, so there is no unit picker here.
struct AdjustCountSheet: View {
    let session: RecountSession
    let row: RecountRow
    let binName: String?
    private let initialText: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft: AdjustmentQuantityDraft
    @State private var draftDismissal = DraftDismissalState()
    @FocusState private var countFocused: Bool

    init(session: RecountSession, row: RecountRow, binName: String?) {
        self.session = session
        self.row = row
        self.binName = binName
        let draft = AdjustmentQuantityDraft(value: row.amount.value)
        initialText = draft.text
        // Presented via `.sheet(isPresented:)` at a fixed call site (`BinRowView`) — dismissing
        // tears the subtree down, so re-presenting rebuilds this seed fresh.
        _draft = State(initialValue: draft)  // state-init-ok
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(row.product.name) {
                        Text(BinRowView.amountText(row.amount))
                            .font(.fieldGuideData)
                    }
                    .accessibilityLabel("\(row.product.name), recorded \(BinRowView.amountText(row.amount))")
                } footer: {
                    Text(stagingNote)
                }
                Section {
                    HStack(spacing: FieldGuideTokens.Space.sm) {
                        TextField("Count", text: $draft.text)
                            .keyboardDismissBar()
                            #if os(iOS)
                                .keyboardType(.decimalPad)
                            #endif
                            .font(.fieldGuideData)
                            .focused($countFocused)
                            .onSubmit(save)
                            .accessibilityIdentifier("audit.adjust-count.amount")
                        Text(row.amount.unit)
                            .font(.fieldGuideLabel)
                            .foregroundStyle(FieldGuideTokens.graphiteSecondary)
                    }
                } header: {
                    Text("Counted")
                } footer: {
                    if hasValidationError {
                        Label("Enter an amount greater than zero.", systemImage: "exclamationmark.circle")
                            .foregroundStyle(FieldGuideTokens.destructive)
                            .accessibilityIdentifier("audit.adjust-count.error")
                    }
                }
            }
            .formStyle(.grouped)
            .onAppear { countFocused = true }
            .navigationTitle("Adjust count")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        draftDismissal.request(isDirty: isDirty, dismiss: dismiss)
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Use count", action: save)
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
        session.stage(.adjust(Amount(value: value, unit: row.amount.unit)), for: row.id)
        dismiss()
    }

    private var stagingNote: String {
        let place = binName.map { "Recorded in \($0). " } ?? ""
        return "\(place)The new count applies when you finish this bin."
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
        row: AuditPreviewData.sampleRow,
        binName: "Bin 1"
    )
}
