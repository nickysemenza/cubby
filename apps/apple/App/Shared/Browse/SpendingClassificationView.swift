import CubbyKit
import SwiftUI

struct SpendingClassificationView: View {
    let key: EntityKey
    let row: EntityRow
    @Environment(AppModel.self) private var appModel
    @State private var review = SpendingClassificationReviewSession()
    @State private var mappingMode: SpendingCategoryMappingMode = .inherit
    @State private var profile: VendorSpendingProfile = .unspecified
    @State private var category: EntityPick?
    @State private var choosingCategory = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            if key == .productCategory {
                Picker("Spending default", selection: $mappingMode) {
                    Text("Inherit from parent").tag(SpendingCategoryMappingMode.inherit)
                    Text("Map to category").tag(SpendingCategoryMappingMode.mapped)
                    Text("Block automatic defaults").tag(SpendingCategoryMappingMode.blocked)
                }
                .disabled(review.isBusy)
            } else {
                Picker("Vendor context", selection: $profile) {
                    ForEach(VendorSpendingProfile.allCases, id: \.self) { value in
                        Text(value.rawValue.replacingOccurrences(of: "_", with: " ").capitalized).tag(value)
                    }
                }
                .disabled(review.isBusy)
            }
            if key == .vendor || mappingMode == .mapped {
                Button {
                    choosingCategory = true
                } label: {
                    LabeledContent("Category", value: category?.title ?? "No default")
                }
                .disabled(review.isBusy)
                if category != nil {
                    Button("Clear category") { category = nil }.disabled(review.isBusy)
                }
            }
            Button("Review historical impact") { Task { await prepare() } }
                .disabled(
                    review.isBusy || (key == .productCategory && mappingMode == .mapped && category == nil)
                )
                .accessibilityIdentifier("spending.classification.preview")
            if let preview = review.preview {
                LabeledContent("Expenses affected", value: String(preview.changedExpenseCount))
                LabeledContent(
                    "Unclassified after change", value: String(preview.afterUncategorizedExpenseCount))
                Text("Category totals include recorded and planned ledger amounts.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(preview.categoryDeltas.filter { $0.deltaCents != "0" }, id: \.spendingCategoryId) {
                    delta in
                    LabeledContent(delta.spendingCategoryName ?? "Unclassified") {
                        VStack(alignment: .trailing) {
                            Text("\(money(delta.beforeCents)) → \(money(delta.afterCents))")
                            Text("Change: \(money(delta.deltaCents))").font(.caption).foregroundStyle(
                                .secondary)
                        }
                        .monospacedDigit()
                    }
                }
                if preview.unpricedExpenseCount > 0 {
                    Text("\(preview.unpricedExpenseCount) unpriced expenses are excluded from dollar totals.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button("Apply reviewed change") { Task { await apply() } }
                    .disabled(review.isBusy)
                    .accessibilityIdentifier("spending.classification.apply")
            }
            if review.isBusy { ProgressView("Checking classification…") }
            if review.applied { Label("Classification updated", systemImage: "checkmark.circle") }
            if let error { Text(error).foregroundStyle(.secondary).textSelection(.enabled) }
        }
        .task(id: row.id) { loadSelection() }
        .onChange(of: mappingMode) { _, _ in review.invalidateReview() }
        .onChange(of: profile) { _, _ in review.invalidateReview() }
        .onChange(of: category) { _, _ in review.invalidateReview() }
        .sheet(isPresented: $choosingCategory) {
            EntityPickerSheet(target: .spendingCategory, selected: [category?.id].compactMap { $0 }) {
                category = $0.first
            }
            .nativeSheet(.picker)
        }
    }

    private func loadSelection() {
        mappingMode =
            SpendingCategoryMappingMode(rawValue: row.raw["spendingCategoryMode"]?.stringValue ?? "inherit")
            ?? .inherit
        profile =
            VendorSpendingProfile(rawValue: row.raw["spendingProfile"]?.stringValue ?? "unspecified")
            ?? .unspecified
        let field = key == .vendor ? "defaultSpendingCategoryId" : "spendingCategoryId"
        category = row.raw[field]?.stringValue.map { EntityPick(id: $0, title: $0) }
    }

    private func money(_ cents: String) -> String {
        guard let value = Decimal(string: cents) else { return "\(cents) cents" }
        return (value / 100).formatted(.currency(code: "USD"))
    }

    private func prepare() async {
        error = nil
        do {
            let input: SpendingClassificationReviewInputRequest =
                key == .productCategory
                ? .productCategory(
                    .init(
                        action: .productCategory, productCategoryId: row.id,
                        spendingCategoryMode: mappingMode,
                        spendingCategoryId: mappingMode == .mapped ? category?.id : nil))
                : .vendor(
                    .init(
                        action: .vendor, vendorId: row.id, spendingProfile: profile,
                        defaultSpendingCategoryId: category?.id))
            try await review.prepare(input, client: appModel.client)
        } catch {
            Diagnostics.report(error, context: "Spending classification preview")
            self.error = error.localizedDescription
        }
    }

    private func apply() async {
        error = nil
        do {
            try await review.apply(client: appModel.client)
            appModel.recordEntityMutation(keys: [
                .productCategory, .vendor, .expense, .purchase, .financialTransaction,
            ])
        } catch {
            Diagnostics.report(error, context: "Spending classification apply")
            self.error = error.localizedDescription
        }
    }
}

#Preview(traits: .modifier(SignedInPreview())) {
    SpendingClassificationView(
        key: .vendor,
        row: EntityRow(
            id: "VEN-4K7M", title: "Synthetic market", subtitle: nil, imageURL: nil,
            raw: .object(["spendingProfile": .string("food_retail")])
        )
    ).padding()
}
