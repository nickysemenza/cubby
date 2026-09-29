import Foundation
import Testing

@testable import CubbyKit

@Suite("List totals summary")
struct ListTotalsSummaryTests {
    @Test func distinguishesMissingTotalsFromZeroAndCredits() {
        let totals = [
            ListTotalDescriptor(id: "cost", label: "Cost", keys: ["cost"], format: .currency),
            ListTotalDescriptor(id: "count", label: "Expenses", keys: ["expenseCount"], format: .integer),
        ]

        #expect(
            ListTotalsSummary.line(totals: totals, sums: nil, locale: Locale(identifier: "en_US"))
                == "All matching · Cost: Unavailable · Expenses: Unavailable")
        #expect(
            ListTotalsSummary.line(
                totals: totals, sums: ["cost": 0, "expenseCount": 0],
                locale: Locale(identifier: "en_US"))
                == "All matching · Cost: $0.00 · Expenses: 0")
        #expect(
            ListTotalsSummary.line(
                totals: totals, sums: ["cost": -12.5, "expenseCount": 2],
                locale: Locale(identifier: "en_US"))
                == "All matching · Cost: -$12.50 · Expenses: 2")
    }

    @Test func rangeRequiresBothServerValues() {
        let totals = [
            ListTotalDescriptor(
                id: "priceRange", label: "Price range", keys: ["priceLow", "priceHigh"],
                format: .currencyRange)
        ]

        #expect(
            ListTotalsSummary.line(
                totals: totals, sums: ["priceLow": 10], locale: Locale(identifier: "en_US"))
                == "All matching · Price range: Unavailable")
        #expect(
            ListTotalsSummary.line(
                totals: totals, sums: ["priceLow": 10, "priceHigh": 20],
                locale: Locale(identifier: "en_US"))
                == "All matching · Price range: $10.00–$20.00")
    }

    @Test func noDeclaredTotalsProducesNoSummary() {
        #expect(ListTotalsSummary.line(totals: [], sums: ["cost": 10]) == nil)
    }
}
