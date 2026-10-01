import CubbyKit
import SwiftUI

struct SpendingCategorySummaryView: View {
    let summary: SpendingCategorySummary
    let contextOnly: Bool

}

extension SpendingCategorySummary {
    var classificationLabel: String {
        switch state {
        case .single: "Single category"
        case .mixed: "Mixed categories"
        case .partial: "Partially classified"
        case .unclassified: "Unclassified"
        case .notApplicable: "Not applicable"
        }
    }

}

extension SpendingCategorySummaryView {
    var body: some View {
        VStack(alignment: .leading, spacing: FieldGuideTokens.Space.sm) {
            Text(summary.classificationLabel).font(.headline)
            if summary.state != .notApplicable {
                Text(
                    summary.lineCount == 0
                        ? "No linked expense lines."
                        : "\(summary.categorizedLineCount) of \(summary.lineCount) expense lines classified."
                )
                .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(summary.categories, id: \.id) { category in
                LabeledContent {
                    if !contextOnly, let amount = category.amount {
                        Text(amount.formatted(.currency(code: "USD"))).monospacedDigit()
                    }
                } label: {
                    NavigationLink(value: Route.entityDetail(.spendingCategory, id: category.id)) {
                        Text(category.name)
                    }
                }
            }
            if !summary.categories.isEmpty {
                if contextOnly {
                    Text(
                        "Categories describe linked expenses. Settlement amounts are not attributed to categories."
                    )
                    .font(.caption).foregroundStyle(.secondary)
                } else if !summary.amountsKnown {
                    Text("Some expense amounts are unknown.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

#Preview {
    SpendingCategorySummaryView(
        summary: .init(
            state: .mixed, categories: [], lineCount: 2, categorizedLineCount: 2, uncategorizedLineCount: 0,
            complete: true, amountsKnown: false),
        contextOnly: true
    ).padding()
}
