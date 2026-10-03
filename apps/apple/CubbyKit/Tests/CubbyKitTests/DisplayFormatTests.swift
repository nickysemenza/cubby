import Foundation
import Testing

@testable import CubbyKit

/// Shared with `apps/web/src/lib/display-format.unit.test.ts`: both clients render a field's
/// display format identically (`packages/shared/golden-vectors/display-format.json`).
@Suite("DisplayFormat")
struct DisplayFormatTests {
    private struct MoneyVector: Decodable {
        let value: Double
        let out: String
    }
    private struct DateVector: Decodable {
        let `in`: String
        let out: String
    }
    private struct EstimateVector: Decodable {
        let unit: String
        let estimate: MeasureEstimate
        let out: String
    }
    private struct File: Decodable {
        let currency: [MoneyVector]
        let signedCurrency: [MoneyVector]
        let plainDate: [DateVector]
        let number: [MoneyVector]
        let compactEstimate: [EstimateVector]
    }

    private func vectors() throws -> File {
        try GoldenVectors.decode(File.self, named: "display-format")
    }

    @Test func currencyMatchesTheSharedVectors() throws {
        for vector in try vectors().currency {
            #expect(DisplayFormat.currency(vector.value) == vector.out, "value \(vector.value)")
        }
    }

    @Test func signedCurrencyMatchesTheSharedVectors() throws {
        for vector in try vectors().signedCurrency {
            #expect(DisplayFormat.currency(vector.value) == vector.out, "value \(vector.value)")
        }
    }

    @Test func plainDateMatchesTheSharedVectors() throws {
        for vector in try vectors().plainDate {
            #expect(DisplayFormat.plainDate(vector.in) == vector.out, "input \(vector.in)")
        }
    }

    @Test func numberMatchesTheSharedVectors() throws {
        for vector in try vectors().number {
            #expect(DisplayFormat.number(vector.value) == vector.out, "value \(vector.value)")
        }
    }

    @Test func compactEstimateMatchesTheSharedVectors() throws {
        for vector in try vectors().compactEstimate {
            let unit: DisplayFormat.EstimateUnit = vector.unit == "kcal" ? .kcal : .macro
            #expect(
                DisplayFormat.compactEstimate(vector.estimate, unit: unit) == vector.out,
                "\(vector.unit) \(vector.out)")
        }
    }
}
