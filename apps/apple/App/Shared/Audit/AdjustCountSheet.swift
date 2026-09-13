import CubbyKit
import SwiftUI

/// Stages a corrected count for one row. The unit is read-only — a recount corrects the quantity
/// counted, never the unit a product is tracked in, so there is no unit picker here.
struct AdjustCountSheet: View {
    let session: RecountSession
    let id: InventoryEntryCode
    let unit: String
    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(session: RecountSession, id: InventoryEntryCode, amount: Amount) {
        self.session = session
        self.id = id
        self.unit = amount.unit
        _text = State(initialValue: Self.formatted(amount.value))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("New count") {
                    HStack(spacing: PorcelainTokens.Space.sm) {
                        TextField("Count", text: $text)
                            .keyboardDismissBar()
                            #if os(iOS)
                                .keyboardType(.decimalPad)
                            #endif
                            .font(.porcelainData)
                        Text(unit)
                            .font(.porcelainLabel)
                            .foregroundStyle(PorcelainTokens.graphiteSecondary)
                    }
                }
            }
            .navigationTitle("Adjust count")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(Double(text) == nil)
                }
            }
        }
        #if os(macOS)
            .frame(minWidth: 320, minHeight: 220)
        #endif
    }

    private func save() {
        guard let value = Double(text) else { return }
        session.stage(.adjust(Amount(value: value, unit: unit)), for: id)
        dismiss()
    }

    private static func formatted(_ value: Double) -> String {
        value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
    }
}

#Preview("Adjust count") {
    AdjustCountSheet(
        session: RecountSession(service: PreviewFixtures.signedInModel().client),
        id: AuditPreviewData.sampleRow.id,
        amount: AuditPreviewData.sampleRow.amount
    )
}
