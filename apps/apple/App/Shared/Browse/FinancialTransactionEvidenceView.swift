import CubbyKit
import SwiftUI

struct FinancialTransactionEvidenceView: View {
    let row: EntityRow
    let onChanged: () -> Void
    @Environment(AppModel.self) private var appModel
    @State private var category: EntityPick?
    @State private var purchase: EntityPick?
    @State private var vendor: EntityPick?
    @State private var choosingCategory = false
    @State private var choosingPurchase = false
    @State private var choosingVendor = false
    @State private var economicRole = "vendor"
    @State private var preview: FinancialBookingPreview?
    @State private var result: FinancialBookingResult?
    @State private var error: String?
    @State private var busy = false

    private var coverage: JSONValue? { row.raw["coverage"] }
    private var canBook: Bool {
        row.raw["status"]?.stringValue != "void"
            && ["purchase", "refund", "adjustment", "fee", "interest", "income"].contains(
                row.raw["kind"]?.stringValue ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text("Spending review").font(.subheadline.weight(.semibold))
            coverageRow("Expense booking", key: "booking")
            coverageRow("Receipt or order", key: "document")
            coverageRow("Itemization", key: "itemization")
            coverageRow("Products", key: "products")
            if canBook { bookingControls }
            if coverage?["booking"]?.stringValue == "recorded", row.raw["status"]?.stringValue != "void" {
                FinancialBookingCorrectionView(row: row, onChanged: onChanged)
            }
            if let result {
                Label(
                    result.replayed
                        ? "Settlement already recorded"
                        : result.expenseId == nil ? "Linked existing Expenses" : "Expense booking recorded",
                    systemImage: "checkmark.circle.fill"
                )
                .foregroundStyle(FieldGuideTokens.positive)
            }
            if let error { Text(error).foregroundStyle(FieldGuideTokens.destructive) }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("financial.evidence.review")
        .task(id: row.id) { resetSelections() }
        .onChange(of: category) { _, _ in preview = nil }
        .onChange(of: purchase) { _, _ in preview = nil }
        .onChange(of: vendor) { _, _ in preview = nil }
        .onChange(of: economicRole) { _, _ in preview = nil }
        .sheet(isPresented: $choosingCategory) {
            EntityPickerSheet(target: .spendingCategory, selected: [category?.id].compactMap { $0 }) {
                category = $0.first
            }
            .nativeSheet(.picker)
        }
        .sheet(isPresented: $choosingPurchase) {
            EntityPickerSheet(target: .purchase, selected: [purchase?.id].compactMap { $0 }) {
                purchase = $0.first
            }
            .nativeSheet(.picker)
        }
        .sheet(isPresented: $choosingVendor) {
            EntityPickerSheet(target: .vendor, selected: [vendor?.id].compactMap { $0 }) {
                vendor = $0.first
            }
            .nativeSheet(.picker)
        }
    }

    private func coverageRow(_ title: String, key: String) -> some View {
        let state = coverage?[key]?.stringValue ?? "unknown"
        let label: String =
            switch state {
            case "not_expected": "Not expected"
            case "not_applicable": "Not applicable"
            case "recorded": "Recorded"
            case "present": "Present"
            case "partial": "Partial"
            case "missing": "Missing"
            default: "Unclassified"
            }
        return LabeledContent(title) {
            Label(label, systemImage: coverageSymbol(state))
        }
        .accessibilityIdentifier("financial.coverage.\(key)")
    }

    private func coverageSymbol(_ state: String) -> String {
        switch state {
        case "recorded", "present": "checkmark.circle.fill"
        case "not_expected", "not_applicable": "minus.circle"
        case "partial": "circle.lefthalf.filled"
        default: "circle.dotted"
        }
    }

    @ViewBuilder private var bookingControls: some View {
        Button {
            choosingCategory = true
        } label: {
            LabeledContent(
                "Spending category",
                value: category?.title ?? (purchase == nil ? "Choose category" : "Use purchase category"))
        }
        .disabled(busy)
        .accessibilityIdentifier("financial.booking.category")
        Button {
            choosingPurchase = true
        } label: {
            LabeledContent("Purchase", value: purchase?.title ?? "Create a purchase")
        }
        .disabled(busy)
        .accessibilityIdentifier("financial.booking.purchase")
        if purchase != nil {
            Button("Use a new purchase") { purchase = nil }
                .disabled(busy)
        } else {
            Button {
                choosingVendor = true
            } label: {
                LabeledContent("Vendor", value: vendor?.title ?? "Choose vendor")
            }
            .disabled(busy)
            .accessibilityIdentifier("financial.booking.vendor")
        }
        Picker("Economic role", selection: $economicRole) {
            Text("Vendor spending").tag("vendor")
            Text("Reimbursement").tag("reimbursement")
        }
        .disabled(busy)
        Button("Review Expense booking") { Task { await prepareBooking() } }
            .disabled(busy || (category == nil && purchase == nil) || (purchase == nil && vendor == nil))
            .accessibilityIdentifier("financial.booking.preview")
        if let preview {
            LabeledContent("Name", value: preview.name)
            LabeledContent("Date", value: preview.date)
            LabeledContent(
                "Action",
                value: preview.action == .linkExisting ? "Link existing Expenses" : "Create aggregate Expense"
            )
            LabeledContent("Settlement", value: preview.amount.formatted(.currency(code: "USD")))
            LabeledContent("Account", value: preview.accountName)
            LabeledContent("Funder", value: preview.funderName ?? "No account owner recorded")
            LabeledContent("Trade", value: preview.trade.rawValue.capitalized)
            LabeledContent("Cost type", value: preview.costType.rawValue.capitalized)
            LabeledContent(
                "Signed booked amount", value: preview.existingBookedAmount.formatted(.currency(code: "USD")))
            LabeledContent(
                "Prior vendor settlements",
                value: preview.previouslySettledAmount.formatted(.currency(code: "USD")))
            LabeledContent(
                "Remaining booked amount",
                value: preview.remainingBookedAmount.formatted(.currency(code: "USD")))
            Text(
                preview.action == .linkExisting
                    ? "This links the existing Expenses to this settlement."
                    : "This records the reviewed spending in the Expense ledger. Source rows stay as evidence."
            )
            .foregroundStyle(.secondary)
            Button(preview.action == .linkExisting ? "Link reviewed settlement" : "Book reviewed Expense") {
                Task { await commitBooking(preview) }
            }
            .disabled(busy)
            .accessibilityIdentifier("financial.booking.commit")
        }
        if busy { ProgressView("Checking booking…") }
    }

    private func resetSelections() {
        category = row.raw["spendingCategoryId"]?.stringValue.map { EntityPick(id: $0, title: $0) }
        purchase = row.raw["purchaseId"]?.stringValue.map { EntityPick(id: $0, title: $0) }
        vendor = nil
        economicRole = "vendor"
        preview = nil
        result = nil
        error = nil
    }

    private func prepareBooking() async {
        busy = true
        defer { busy = false }
        error = nil
        do {
            preview = try await appModel.client.previewFinancialBooking(
                .init(
                    transactionId: row.id, purchaseId: purchase?.id, vendorId: vendor?.id,
                    spendingCategoryId: category?.id, trade: .other,
                    economicRole: economicRole == "reimbursement" ? .reimbursement : .vendor))
        } catch {
            Diagnostics.report(error, context: "Preview Expense booking")
            self.error = error.localizedDescription
        }
    }

    private func commitBooking(_ reviewed: FinancialBookingPreview) async {
        busy = true
        defer { busy = false }
        error = nil
        do {
            let input = try JSONDecoder.cubby().decode(
                FinancialBookingPreviewInput.self, from: JSONEncoder.cubby().encode(reviewed))
            result = try await appModel.client.commitFinancialBooking(input)
            preview = nil
            appModel.recordEntityMutation(keys: [.financialTransaction, .purchase, .expense])
            onChanged()
        } catch {
            Diagnostics.report(error, context: "Book reviewed Expense")
            self.error = error.localizedDescription
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    FinancialTransactionEvidenceView(
        row: EntityRow(
            id: "FTX-4K7M", title: "Synthetic Outfitters", subtitle: nil, imageURL: nil,
            raw: .object(["kind": .string("purchase"), "status": .string("posted")])),
        onChanged: {}
    )
    .padding()
}
