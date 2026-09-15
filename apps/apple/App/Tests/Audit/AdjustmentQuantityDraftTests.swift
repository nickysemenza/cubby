import Foundation
import Testing

@testable import Cubby

@Suite("Adjustment quantity draft")
struct AdjustmentQuantityDraftTests {
    @Test func parsesDecimalCommaLocale() {
        let draft = AdjustmentQuantityDraft(text: "1,25", locale: Locale(identifier: "de_DE"))

        #expect(draft.value == 1.25)
    }

    @Test func parsesFractionalAmount() {
        let draft = AdjustmentQuantityDraft(text: "0.125", locale: Locale(identifier: "en_US"))

        #expect(draft.value == 0.125)
    }

    @Test(
        "Rejects values outside the server contract",
        arguments: ["", "   ", "not a number", "0", "-1", "NaN", "infinity", "1e309"])
    func rejectsInvalidAmount(_ text: String) {
        let draft = AdjustmentQuantityDraft(text: text, locale: Locale(identifier: "en_US"))

        #expect(draft.value == nil)
    }

    @Test func validatesCurrentTextAfterEarlierValidText() {
        var draft = AdjustmentQuantityDraft(text: "2.5", locale: Locale(identifier: "en_US"))
        #expect(draft.value == 2.5)

        draft.text = "2.5 items"

        #expect(draft.value == nil)
    }

    @Test func rejectsWrongLocaleSeparatorAndTrailingInput() {
        #expect(
            AdjustmentQuantityDraft(text: "1,25", locale: Locale(identifier: "en_US")).value == nil)
        #expect(
            AdjustmentQuantityDraft(text: "1.25", locale: Locale(identifier: "de_DE")).value == nil)
        #expect(
            AdjustmentQuantityDraft(text: "1.25 remaining", locale: Locale(identifier: "en_US")).value
                == nil)
    }

    @Test func initialValueKeepsDoublePrecision() {
        let value = 0.123_456_789_012_345_66
        let draft = AdjustmentQuantityDraft(value: value, locale: Locale(identifier: "en_US"))

        #expect(draft.value == value)
    }
}
