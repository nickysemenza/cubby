import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Entity field values")
struct EntityFieldValueTests {
    /// A `yyyy-MM-dd` column keeps its calendar day regardless of the device zone.
    @Test func dateOnlyValueKeepsItsCalendarDay() {
        let rendered = EntityFieldValue.formattedDate("2039-05-10")
        #expect(rendered == "May 10, 2039")
    }

    /// `format: "amount"` renders the `{value, unit}` shape the inventory list carries.
    @Test func amountFormatRendersValueAndUnit() throws {
        let field = try #require(EntityCatalog[.inventory].field("amount"))
        #expect(field.format == "amount")
        #expect(EntityFieldValue.text(["value": 2, "unit": "each"], field: field) == "2 each")
        #expect(EntityFieldValue.text(["value": 1.5], field: field) == "1.5")
        #expect(EntityFieldValue.text(.null, field: field) == nil)
    }

    /// A detail row reads where the declaration says: the nested kind through its `valueOptions`
    /// labels, a server-composed sentence verbatim, and never a count of the structure behind it.
    @Test func detailReadsDeclaredPathsLabelsAndSentences() throws {
        let identity = try #require(EntityCatalog[.financialAccount].field("identity"))
        let account: JSONValue = ["identity": ["kind": "credit_card", "issuer": .null, "network": "visa"]]
        #expect(EntityFieldValue.text(in: account, field: identity, surface: "detail") == "Credit card")

        let cards = try #require(EntityCatalog[.financialAccount].field("cardNumbers"))
        let withLabel: JSONValue = [
            "cardNumbers": [["last4": "1234"]], "cardNumbersLabel": "•••• 1234 · primary",
        ]
        #expect(
            EntityFieldValue.text(in: withLabel, field: cards, surface: "detail") == "•••• 1234 · primary")
        #expect(
            EntityFieldValue.text(in: ["cardNumbers": [["last4": "1234"]]], field: cards, surface: "detail")
                == nil)

        let meta = try #require(EntityCatalog[.recipe].field("meta"))
        #expect(
            EntityFieldValue.text(
                in: ["meta": ["url": "https://recipes.example.test/soup"]], field: meta, surface: "detail")
                == "https://recipes.example.test/soup")
        let yield = try #require(EntityCatalog[.recipe].field("yield"))
        #expect(
            EntityFieldValue.text(
                in: ["yield": ["value": 4, "unit": "serving"]], field: yield, surface: "detail")
                == "4 serving")
    }

    /// A reference field resolves its target from the sibling `<stem>Name` projection, or from
    /// a nested `<stem>: {id, name}` object when the list row embeds one instead.
    @Test func referenceResolvesProjectedNameOrNestedObject() throws {
        let planting = EntityCatalog[.planting]
        let location = try #require(planting.field("locationId"))
        let flat: JSONValue = ["id": "PLT-1", "locationId": "LOC-1", "locationName": "Raised bed A"]
        let resolved = try #require(EntityFieldValue.reference(in: flat, field: location))
        #expect(resolved.entity == .location)
        #expect(resolved.id == "LOC-1")
        #expect(resolved.name == "Raised bed A")

        let inventory = try #require(EntityCatalog[.inventory].field("locationId"))
        let nested: JSONValue = ["id": "INV-1", "location": ["id": "LOC-2", "name": "Pantry"]]
        let embedded = try #require(EntityFieldValue.reference(in: nested, field: inventory))
        #expect(embedded.id == "LOC-2")
        #expect(embedded.name == "Pantry")

        #expect(EntityFieldValue.reference(in: ["id": "PLT-1"], field: location) == nil)
    }
}
