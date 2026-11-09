import Foundation
import Testing

@testable import CubbyKit

/// Shared with `apps/web/src/lib/display-format.unit.test.ts`: both clients render a field's
/// display format identically (`packages/shared/golden-vectors/display-format.json`).
/// The Rust tests own the rules; these check the UniFFI bindings against the same vectors.
@Suite("ValueFormat")
struct ValueFormatTests {
    private struct MoneyVector: Decodable {
        let value: Double
        let out: String
    }
    private struct DateVector: Decodable {
        let `in`: String
        let out: String
    }
    private struct TextVector: Decodable {
        let value: String?
        let emptyLabel: String?
        let detail: Bool
        let out: String
    }
    private struct CountVector: Decodable {
        let value: Double
        let decimals: UInt32
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
    private struct AmountVector: Decodable {
        let unit: String
        let value: Double
        let upper: Double?
        let out: String
    }
    private struct File: Decodable {
        let amount: [AmountVector]
        let currency: [MoneyVector]
        let signedCurrency: [MoneyVector]
        let plainDate: [DateVector]
        let text: [TextVector]
        let count: [CountVector]
        let number: [MoneyVector]
        let compactEstimate: [EstimateVector]
        let estimate: [LabelVector]
    }

    private func vectors() throws -> File {
        try GoldenVectors.decode(File.self, named: "display-format")
    }

    @Test func currencyMatchesTheSharedVectors() throws {
        for vector in try vectors().currency {
            #expect(ValueFormat.currency(vector.value) == vector.out, "value \(vector.value)")
        }
    }

    @Test func signedCurrencyMatchesTheSharedVectors() throws {
        for vector in try vectors().signedCurrency {
            #expect(ValueFormat.currency(vector.value) == vector.out, "value \(vector.value)")
        }
    }

    @Test func plainDateMatchesTheSharedVectors() throws {
        for vector in try vectors().plainDate {
            #expect(ValueFormat.plainDate(vector.in) == vector.out, "input \(vector.in)")
        }
    }

    @Test func numberMatchesTheSharedVectors() throws {
        for vector in try vectors().number {
            #expect(ValueFormat.number(vector.value) == vector.out, "value \(vector.value)")
        }
    }

    @Test func textMatchesTheSharedVectors() throws {
        for vector in try vectors().text {
            #expect(
                ValueFormat.text(vector.value, emptyLabel: vector.emptyLabel, detail: vector.detail)
                    == vector.out)
        }
    }

    @Test func countMatchesTheSharedVectors() throws {
        for vector in try vectors().count {
            #expect(ValueFormat.count(vector.value, maxFractionDigits: vector.decimals) == vector.out)
        }
    }

    @Test func compactEstimateMatchesTheSharedVectors() throws {
        for vector in try vectors().compactEstimate {
            let unit: ValueFormat.CompactUnit = vector.unit == "kcal" ? .kcal : .macro
            #expect(
                ValueFormat.compactEstimate(vector.estimate, unit: unit) == vector.out,
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
                ValueFormat.estimate(vector.estimate, measure: measure, unit: vector.unit) == vector.out,
                "\(vector.measure) \(vector.out)")
        }
    }

    @Test func amountMatchesTheSharedVectors() throws {
        for vector in try vectors().amount {
            #expect(
                ValueFormat.amount(unit: vector.unit, value: vector.value, upperValue: vector.upper)
                    == vector.out,
                "\(vector.unit) \(vector.value)")
        }
    }

    @Test func aMissingUnitIsABareCount() {
        #expect(ValueFormat.amount(unit: nil, value: 1.5) == "1.5")
    }
}
