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
    private struct LabelVector: Decodable {
        let measure: String
        let unit: String?
        let estimate: MeasureEstimate
        let out: String
    }
    private struct File: Decodable {
        let currency: [MoneyVector]
        let signedCurrency: [MoneyVector]
        let plainDate: [DateVector]
        let number: [MoneyVector]
        let compactEstimate: [EstimateVector]
        let estimate: [LabelVector]
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

    @Test func estimateMatchesTheSharedVectors() throws {
        let measures: [String: ValueFormat.EstimateMeasure] = [
            "cost": .cost, "kcal": .kcal, "macro": .macro, "share": .share,
        ]
        for vector in try vectors().estimate {
            let measure = try #require(measures[vector.measure])
            #expect(
                DisplayFormat.estimate(vector.estimate, measure: measure, unit: vector.unit) == vector.out,
                "\(vector.measure) \(vector.out)")
        }
    }
}

/// Amounts are formatted by the same Rust the web calls (`wasm.format_amount_labeled`).
@Suite("ValueFormat")
struct ValueFormatTests {
    @Test func amountMatchesTheWebUnitFormatter() {
        #expect(ValueFormat.amount(unit: "each", value: 3) == "3 each")
        #expect(ValueFormat.amount(unit: "cup", value: 2.5) == "2½ cups")
        #expect(ValueFormat.amount(unit: "cup", value: 2, upperValue: 3) == "2 - 3 cups")
    }

    @Test func aBareCountIsAPlainNumber() {
        #expect(ValueFormat.amount(unit: nil, value: 1.5) == "1.5")
        #expect(ValueFormat.amount(unit: "", value: 12) == "12")
    }
}
