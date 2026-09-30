import CubbyKit
import SwiftUI

struct FinancialBookingCorrectionView: View {
    let row: EntityRow
    let onChanged: () -> Void
    @Environment(AppModel.self) private var appModel
    @State private var mode = "convert_to_transfer"
    @State private var target: EntityPick?
    @State private var choosingTarget = false
    @State private var preview: FinancialBookingCorrectionPreview?
    @State private var result: FinancialBookingCorrectionResult?
    @State private var error: String?
    @State private var busy = false

    private var isCredit: Bool { (row.raw["amount"]?.doubleValue ?? 0) < 0 }
    private var targetEntity: EntityKey { mode == "attach_reimbursement" ? .purchase : .ledgerTransfer }

    var body: some View {
        DisclosureGroup("Correct recorded booking") {
            VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
                Picker("Correction", selection: $mode) {
                    Text("Convert to transfer").tag("convert_to_transfer")
                    if isCredit { Text("Attach as reimbursement").tag("attach_reimbursement") }
                }
                .disabled(busy)
                Button {
                    choosingTarget = true
                } label: {
                    LabeledContent(
                        targetEntity == .purchase ? "Purchase" : "Ledger transfer",
                        value: target?.title ?? "Choose existing record")
                }
                .disabled(busy)
                .accessibilityIdentifier("financial.correction.target")
                if let preview {
                    LabeledContent("Target", value: preview.targetName)
                    LabeledContent("Target category default", value: preview.categoryName ?? "None")
                    LabeledContent("Target project default", value: preview.projectName ?? "None")
                    LabeledContent(
                        "Target trade default", value: preview.trade?.rawValue.capitalized ?? "None")
                    Text(
                        "Target defaults apply where an Expense has no override; existing Expense overrides remain."
                    )
                    .foregroundStyle(.secondary)
                    LabeledContent("Settlement", value: preview.amount.formatted(.currency(code: "USD")))
                    Text("Expenses to retire").font(.caption.weight(.semibold))
                    ForEach(Array(preview.lines.enumerated()), id: \.offset) { _, line in
                        VStack(alignment: .leading) {
                            LabeledContent(line.title, value: line.amount.formatted(.currency(code: "USD")))
                            if let notes = line.notes, !notes.isEmpty {
                                Text(notes).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Text(
                        "Apply retires only these reviewed aggregate Expenses and updates this settlement. The server rejects edited or itemized lineages."
                    )
                    .foregroundStyle(.secondary)
                    Button("Apply reviewed correction") { Task { await apply(preview) } }
                        .disabled(busy)
                        .accessibilityIdentifier("financial.correction.apply")
                } else {
                    Button("Review correction") { Task { await prepare() } }
                        .disabled(busy || target == nil)
                        .accessibilityIdentifier("financial.correction.preview")
                }
                if let result {
                    Label(
                        "Correction recorded · \(result.retiredExpenseIds.count) Expenses retired",
                        systemImage: "checkmark.circle.fill"
                    )
                    .foregroundStyle(FieldGuideTokens.positive)
                }
                if let error { Text(error).foregroundStyle(FieldGuideTokens.destructive) }
                if busy { ProgressView("Checking correction…") }
            }
        }
        .font(.caption)
        .onChange(of: mode) { _, _ in
            target = nil; preview = nil
        }
        .onChange(of: target) { _, _ in preview = nil }
        .task(id: row.id) {
            target = nil; preview = nil; result = nil; error = nil
        }
        .sheet(isPresented: $choosingTarget) {
            EntityPickerSheet(target: targetEntity, selected: [target?.id].compactMap { $0 }) {
                target = $0.first
            }
            .nativeSheet(.picker)
        }
    }

    private func prepare() async {
        guard let target else { return }
        busy = true
        defer { busy = false }
        error = nil
        do {
            let input: FinancialBookingCorrectionInput =
                mode == "attach_reimbursement"
                ? .init(
                    transactionId: row.id,
                    action: .attachReimbursement(.init(kind: .attachReimbursement, purchaseId: target.id)))
                : .init(
                    transactionId: row.id,
                    action: .convertToTransfer(.init(kind: .convertToTransfer, transferId: target.id)))
            preview = try await appModel.client.previewFinancialBookingCorrection(input)
        } catch {
            Diagnostics.report(error, context: "Preview booking correction")
            self.error = error.localizedDescription
        }
    }

    private func apply(_ reviewed: FinancialBookingCorrectionPreview) async {
        busy = true
        defer { busy = false }
        error = nil
        do {
            let input = try JSONDecoder.cubby().decode(
                FinancialBookingCorrectionPreviewInput.self, from: JSONEncoder.cubby().encode(reviewed))
            result = try await appModel.client.commitFinancialBookingCorrection(input)
            preview = nil
            appModel.recordEntityMutation(keys: [.financialTransaction, .expense, .purchase, .ledgerTransfer])
            onChanged()
        } catch {
            Diagnostics.report(error, context: "Apply reviewed booking correction")
            self.error = error.localizedDescription
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    FinancialBookingCorrectionView(
        row: EntityRow(
            id: "FTX-4K7M", title: "Synthetic reimbursement", subtitle: nil, imageURL: nil,
            raw: .object(["amount": .number(-29.99)])),
        onChanged: {}
    )
    .padding()
}
