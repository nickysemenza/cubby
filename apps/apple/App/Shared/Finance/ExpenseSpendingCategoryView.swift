import CubbyKit
import SwiftUI

struct ExpenseSpendingCategoryView: View {
    let row: EntityRow

    private var allocations: Result<SpendingCategoryAllocations, any Error> {
        Result {
            guard let value = row.raw["spendingCategoryAllocations"] else {
                throw DecodingError.dataCorrupted(
                    .init(
                        codingPath: [],
                        debugDescription:
                            "Expense.spendingCategoryAllocations: required allocation evidence is missing"))
            }
            return try value.decoded(SpendingCategoryAllocations.self)
        }
    }

    var body: some View {
        if let envelope = FieldEnvelope.of(row.raw, key: "spendingCategoryId") {
            if case .missing = envelope.result {
                LabeledContent(
                    "Spending category", value: envelope.failure == nil ? "Updating…" : "Unavailable")
            } else if !envelope.unsupportedKinds.isEmpty {
                Text("Unsupported spending category: \(envelope.unsupportedKinds.joined(separator: ", "))")
                    .foregroundStyle(.secondary)
            } else {
                switch allocations {
                case .success(let values): allocationRows(values)
                case .failure(let error):
                    Text(error.userMessage).foregroundStyle(FieldGuideTokens.destructive)
                        .task { Diagnostics.report(error, context: "expense.spending-category-allocations") }
                }
            }
        } else {
            Text("Expense.fields.spendingCategoryId: required envelope is missing")
                .foregroundStyle(FieldGuideTokens.destructive)
        }
    }

    @ViewBuilder private func allocationRows(_ allocations: SpendingCategoryAllocations) -> some View {
        if allocations.isEmpty {
            LabeledContent("Spending category", value: "Unclassified")
        } else {
            ForEach(Array(allocations.enumerated()), id: \.offset) { _, allocation in
                LabeledContent {
                    if let amount = allocation.amount {
                        Text(amount.usd).monospacedDigit()
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
            id: "EXP-4K7M", title: "Synthetic adjustment", subtitle: nil, imageURL: nil,
            raw: [
                "spendingCategoryAllocations": [],
                "fields": [
                    "spendingCategoryId": [
                        "current": [
                            "assignment": ["kind": "inherit"],
                            "controls": [
                                "kind": "editable", "canSetNone": false, "canConfirm": false,
                                "reset": ["kind": "unavailable"],
                            ],
                        ],
                        "result": [
                            "kind": "live",
                            "decision": [
                                "outcome": ["kind": "empty", "reason": "unset"], "provenance": .null,
                            ],
                        ],
                        "work": ["kind": "idle"],
                    ]
                ],
            ]
        )
    ).padding()
}
