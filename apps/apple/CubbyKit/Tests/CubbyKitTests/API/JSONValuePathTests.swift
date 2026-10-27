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

    @Test func canonicalResultsOwnScalarAndNestedPaths() {
        let governed: JSONValue = [
            "price": 99,
            "fields": [
                "price": ["result": ["kind": "missing"]],
                "cost": [
                    "result": [
                        "kind": "cached",
                        "decision": [
                            "outcome": ["kind": "value", "value": ["amount": 13]]
                        ],
                    ]
                ],
                "tags": [
                    "result": [
                        "kind": "live",
                        "decision": [
                            "outcome": ["kind": "value", "value": ["a", "b"]]
                        ],
                    ]
                ],
                "categoryId": [
                    "result": [
                        "kind": "live",
                        "decision": [
                            "outcome": ["kind": "empty", "reason": "explicit_none"]
                        ],
                    ]
                ],
                "unknown": ["result": ["kind": "future"]],
            ],
        ]
        #expect(governed.pathValue("price", preservingNull: true) == .null)
        #expect(governed.pathText("price") == nil)
        #expect(governed.pathText("cost.amount") == "13")
        #expect(governed.pathText("tags[]") == "a, b")
        #expect(governed.pathValue("categoryId", preservingNull: true) == .null)
        #expect(governed.pathValue("unknown", preservingNull: true) == nil)
        #expect(governed.pathText("fields.price.result.kind") == "missing")
    }

    @Test func emptyTextIsAbsent() {
        let blank: JSONValue = ["label": ""]
        #expect(blank.pathText("label") == nil)
    }
}
