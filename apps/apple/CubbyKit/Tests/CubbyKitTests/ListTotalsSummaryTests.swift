import Testing

@testable import CubbyKit

@Suite("List totals summary")
struct ListTotalsSummaryTests {
    @Test func printsServerLabelsAndMarksMissingOnesUnavailable() {
        let totals = [
            ListTotalDescriptor(id: "cost", label: "Cost", keys: ["cost"], format: .currency),
            ListTotalDescriptor(id: "count", label: "Expenses", keys: ["expenseCount"], format: .integer),
        ]

        #expect(
            ListTotalsSummary.line(totals: totals, labels: nil)
                == "All matching · Cost: Unavailable · Expenses: Unavailable")
        #expect(
            ListTotalsSummary.line(totals: totals, labels: ["cost": "-$12.50"])
                == "All matching · Cost: -$12.50 · Expenses: Unavailable")
        #expect(ListTotalsSummary.line(totals: [], labels: ["cost": "$10.00"]) == nil)
    }
}
