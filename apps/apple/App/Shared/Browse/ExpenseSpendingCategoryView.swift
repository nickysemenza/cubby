import CubbyKit
import SwiftUI

struct ExpenseSpendingCategoryView: View {
    let row: EntityRow

    var body: some View {
        let allocations = (try? row.decode(Expense.self))?.spendingCategoryAllocations ?? []
        if allocations.isEmpty {
            LabeledContent("Spending category", value: "Unclassified")
        } else {
            ForEach(Array(allocations.enumerated()), id: \.offset) { _, allocation in
                LabeledContent {
                    if let amount = allocation.amount {
                        Text(amount.formatted(.usd)).monospacedDigit()
                    } else {
                        Text("Unpriced").foregroundStyle(.secondary)
                    }
                } label: {
                    if let id = allocation.spendingCategoryId {
                        NavigationLink(value: Route.entityDetail(.spendingCategory, id: id)) {
                            Text(allocation.spendingCategoryName ?? id)
                        }
                    } else {
                        Text("Unclassified")
                    }
                }
                if allocation.incomplete {
                    Text("Classification is incomplete").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

#Preview {
    ExpenseSpendingCategoryView(
        row: EntityRow(
            id: "EXP-4K7M", title: "Synthetic adjustment", subtitle: nil, imageURL: nil, raw: .object([:])
        )
    ).padding()
}
