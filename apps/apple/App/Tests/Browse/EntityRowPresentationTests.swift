import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Entity row presentation")
struct EntityRowPresentationTests {
    @Test func resolvesDeclaredFactsReferencesArraysAndEditTime() throws {
        let descriptor = EntityCatalog[.product]
        let row = EntityRow(
            id: "PRD-1001", title: "Cast Iron Skillet", subtitle: "ignored", imageURL: nil,
            raw: [
                "id": "PRD-1001", "name": "Cast Iron Skillet", "manufacturer": "Lodge",
                "tags": ["kitchen", "cast-iron"], "updatedAt": "2026-09-12T10:00:00.000Z",
            ])

        let presentation = EntityRowPresentation.resolve(descriptor: descriptor, row: row)

        #expect(presentation.title == "Cast Iron Skillet")
        #expect(presentation.shortcode == "PRD-1001")
        #expect(presentation.facts.contains { $0.value == "Lodge" })
        #expect(presentation.facts.contains { $0.value == "kitchen, cast-iron" })
        #expect(presentation.facts.contains { $0.id == "updatedAt" })
        #expect(presentation.factLine?.contains("Manufacturer: Lodge") == true)
        #expect(presentation.accessibilityText.contains("Manufacturer, Lodge"))
    }

    @Test func relationColumnsResolveRenamedReferencesAndZeroCurrency() throws {
        let descriptor = EntityCatalog[.purchase]
        let row = EntityRow(
            id: "PUR-1001", title: "Order", subtitle: nil, imageURL: nil,
            raw: [
                "id": "PUR-1001", "vendorId": "VND-1", "vendorName": "Sample Vendor",
                "statedTotal": 0,
            ])

        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: ["vendor", "statedTotal"])

        #expect(presentation.facts.contains { $0.value == "Sample Vendor" })
        #expect(presentation.facts.contains { $0.value == "$0.00" })
        #expect(presentation.factLine?.contains("Vendor: Sample Vendor") == true)
        #expect(presentation.accessibilityText.contains("Vendor, Sample Vendor"))
    }

    @Test func photoRowsPromoteTheEntitySemanticDateNotThePhotoDate() throws {
        let descriptor = EntityCatalog[.meal]
        let row = EntityRow(
            id: "MEA-1001", title: "Dinner", subtitle: nil, imageURL: nil,
            raw: [
                "id": "MEA-1001", "name": "Dinner", "date": "2026-09-08",
                "updatedAt": "2026-09-12T10:00:00.000Z",
            ])

        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, photoMode: true)

        #expect(presentation.facts.first?.id == "date")
        #expect(presentation.facts.first?.value != "2026-09-08")
        #expect(presentation.factLine?.contains("Date:") == true)
        #expect(presentation.accessibilityText.contains("Date,") == true)
        #expect(!presentation.facts.contains { $0.id == "photo-date" })
    }

    @Test func photoModePromotesSemanticDateWithoutCaptureDate() throws {
        let descriptor = EntityCatalog[.gardenEntry]
        let row = EntityRow(
            id: "GDE-1001", title: "Harvest", subtitle: nil, imageURL: nil,
            raw: ["id": "GDE-1001", "displayName": "Harvest", "observedOn": "2026-09-08"])

        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, photoMode: true)

        #expect(presentation.facts.first?.id == "observedOn")
        #expect(presentation.factLine?.contains("Observed:") == true)
    }

}
