import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Entity field values")
struct EntityFieldValueTests {
    /// A `yyyy-MM-dd` column keeps its calendar day regardless of the device zone.
    @Test func dateOnlyValueKeepsItsCalendarDay() {
        let rendered = EntityFieldValue.formattedDate("2039-05-10", locale: Locale(identifier: "en_US"))
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
