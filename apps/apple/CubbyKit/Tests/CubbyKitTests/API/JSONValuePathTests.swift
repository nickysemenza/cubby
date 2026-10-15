import Testing

@testable import CubbyKit

/// `display.labelPath` and `display.readPath` share one grammar with the web reader
/// (`apps/web/src/entity/read-path.ts`): dotted keys, `[n]`, and a `[]` projection.
@Suite("JSONValue paths")
struct JSONValuePathTests {
    private let row: JSONValue = [
        "quantityLedger": ["expectedLabel": "6 +2?", "locationCount": 1],
        "recipes": [
            ["recipeId": "RCP-AAAA", "recipe": ["name": "Soup"]],
            ["recipeId": "RCP-BBBB", "recipe": ["name": "Bread"]],
        ],
        "tags": ["a", "b"],
        "product": nil,
    ]

    @Test func readsDottedKeysAndIndexes() {
        #expect(row.pathText("quantityLedger.expectedLabel") == "6 +2?")
        #expect(row.pathText("recipes[1].recipe.name") == "Bread")
        #expect(row.pathText("quantityLedger.locationCount") == "1")
    }

    @Test func projectionJoinsEveryElement() {
        #expect(row.pathText("recipes[].recipe.name") == "Soup, Bread")
        #expect(row.pathText("tags[]") == "a, b")
    }

    @Test func missingLinksAreAbsentNotAnError() {
        #expect(row.pathText("product.name") == nil)
        #expect(row.pathText("missing.name") == nil)
        #expect(row.pathText("recipes[5].recipe.name") == nil)
        #expect(row.pathText("quantityLedger.expectedLabel.deeper") == nil)
        #expect(row.pathText("recipes[].missing") == nil)
    }

    @Test func emptyTextIsAbsent() {
        let blank: JSONValue = ["label": ""]
        #expect(blank.pathText("label") == nil)
    }
}
