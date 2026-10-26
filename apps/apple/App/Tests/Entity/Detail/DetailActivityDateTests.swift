import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Detail activity dates")
struct DetailActivityDateTests {
    @Test func calendarDateDoesNotShiftIntoThePreviousZoneDay() throws {
        let date = try #require(ISO8601DateFormatter().date(from: "2026-09-08T00:00:00Z"))

        #expect(DetailActivityDate.day(for: date, allDay: true) == "2026-09-08")
        #expect(DetailActivityDate.day(for: date, allDay: false) == HouseholdDay.string(for: date))
    }

    /// The hero caption reads breadcrumb, then the declared `hero.when`; with neither it falls
    /// back to the list subtitle. The record code is never part of it.
    @Test func heroCaptionReadsBreadcrumbThenWhen() throws {
        let inventory = EntityRow(
            id: "INV-2345", title: "Cast Iron Skillet", subtitle: nil, imageURL: nil,
            raw: [
                "id": "INV-2345",
                "breadcrumb": [
                    ["entity": "location", "id": "LOC-2345", "name": "Home"],
                    ["entity": "location", "id": "LOC-2346", "name": "Shelf B"],
                ],
            ])
        #expect(
            DetailHeaderLine.text(descriptor: EntityCatalog[.inventory], row: inventory) == "Home › Shelf B")

        let purchase = EntityCatalog[.purchase]
        let date = try #require(purchase.field("date"))
        let raw: JSONValue = ["id": "PUR-2345", "date": "2039-05-10"]
        let ordered = try #require(EntityFieldValue.text(in: raw, field: date, surface: "detail"))
        let row = EntityRow(id: "PUR-2345", title: "Synthetic order", subtitle: nil, imageURL: nil, raw: raw)
        #expect(DetailHeaderLine.text(descriptor: purchase, row: row) == "Ordered \(ordered)")

        let product = PreviewFixtures.sampleDetailRow
        #expect(DetailHeaderLine.text(descriptor: EntityCatalog[.product], row: product) == "Lodge")
    }
}
