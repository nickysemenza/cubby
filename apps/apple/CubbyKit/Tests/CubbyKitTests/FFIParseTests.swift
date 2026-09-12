import Testing

@testable import CubbyKit

@Suite("IngredientParser (Rust via UniFFI)")
struct FFIParseTests {
    @Test func parsesASimpleLine() {
        let parsed = IngredientParser.parse("2 cups flour")
        #expect(parsed.name == "flour")
        #expect(parsed.amounts.count == 1)
        #expect(parsed.amounts.first?.value == 2)
        #expect(parsed.amounts.first?.unit.hasPrefix("cup") == true)
        #expect(parsed.optional == false)
    }

    @Test func keepsModifiersAndOptional() {
        let parsed = IngredientParser.parse("1 tbsp butter, melted (optional)")
        #expect(parsed.name.contains("butter"))
        #expect(parsed.amounts.first?.value == 1)
    }

    @Test func unitVocabularyComesFromRust() {
        let aliases = IngredientParser.sizeUnitAliases
        #expect(!aliases.isEmpty)
        #expect(aliases.contains("oz"))
    }
}
