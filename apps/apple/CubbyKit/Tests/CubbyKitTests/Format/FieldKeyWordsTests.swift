import Foundation
import Testing

@testable import CubbyKit

/// Failure modes: dropping the boundary the regex inserted, spacing an all-caps run, or losing
/// the underscore-to-space rewrite the labels relied on.
@Suite("FieldKeyWords")
struct FieldKeyWordsTests {
    @Test func spacesTheSameBoundariesAsTheRegexItReplaced() {
        let inputs = [
            "unitPrice", "unit_price", "dataQualityScore", "usdaFDC", "item2Name", "a_B", "aBcD",
            "URLPath", "", "x", "Ünit", "fooBar_baz",
        ]
        for input in inputs {
            let regex = input.replacingOccurrences(
                of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression
            ).replacingOccurrences(of: "_", with: " ")
            #expect(FieldKeyWords.spaced(input) == regex)
        }
        #expect(FieldKeyWords.spaced("unitPrice") == "unit Price")
    }
}
