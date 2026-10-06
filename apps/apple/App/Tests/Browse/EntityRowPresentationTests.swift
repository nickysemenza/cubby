import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Entity row presentation")
struct EntityRowPresentationTests {
    @Test func qualityLeadsSupportingFactsAndDistinguishesUnassessed() {
        let row = EntityRow(
            id: "PRD-1001", title: "Synthetic skillet", subtitle: nil, imageURL: nil,
            raw: [
                "id": "PRD-1001", "name": "Synthetic skillet", "manufacturer": "Synthetic",
                "dataQuality": ["score": 75, "status": "needs_data"],
            ])
        let presentation = EntityRowPresentation.resolve(descriptor: EntityCatalog[.product], row: row)
        #expect(presentation.facts.first?.id == "dataQuality")
        #expect(presentation.facts.first?.value == "75/100 · Needs data")
        let category = EntityRow(
            id: "SPC-1001", title: "Synthetic tools", subtitle: nil, imageURL: nil,
            raw: [
                "id": "SPC-1001", "name": "Synthetic tools",
                "dataQuality": ["score": .null, "status": "not_assessed"],
            ])
        let unassessed = EntityRowPresentation.resolve(
            descriptor: EntityCatalog[.spendingCategory], row: category)
        #expect(unassessed.facts.first?.value == "Not assessed")
    }

    /// A scored entity's record can itself be unassessed (null score), and an exceptions-only
    /// record must not read as a plain complete 100.
    @Test func qualityShowsNullScoresAndExceptionsOnlyCompleteness() {
        func quality(_ dataQuality: JSONValue) -> String? {
            let row = EntityRow(
                id: "PRD-1001", title: "Synthetic skillet", subtitle: nil, imageURL: nil,
                raw: ["id": "PRD-1001", "name": "Synthetic skillet", "dataQuality": dataQuality])
            return EntityRowPresentation.resolve(descriptor: EntityCatalog[.product], row: row)
                .facts.first?.value
        }
        #expect(quality(["score": .null, "status": "not_assessed"]) == "Not assessed")
        #expect(
            quality(["score": 100, "status": "complete_with_exceptions"])
                == "100/100 · Complete with exceptions")
        #expect(quality(["score": 99, "status": "defect"]) == "99/100 · Defect")
    }

    @Test func resolvesOnlyDeclaredFactsInMetadataOrder() throws {
        let descriptor = EntityCatalog[.product]
        let row = EntityRow(
            id: "PRD-1001", title: "Cast Iron Skillet", subtitle: "ignored", imageURL: nil,
            raw: [
                "id": "PRD-1001", "name": "Cast Iron Skillet", "manufacturer": "Lodge",
                "tags": ["kitchen", "cast-iron"], "updatedAt": "2026-09-12T10:00:00.000Z",
            ])

        let presentation = EntityRowPresentation.resolve(
            descriptor: descriptor, row: row, columns: ["tags", "manufacturer"])

        #expect(presentation.title == "Cast Iron Skillet")
        #expect(presentation.shortcode == "PRD-1001")
        #expect(presentation.facts.map(\.id) == ["dataQuality", "tags", "manufacturer"])
        #expect(presentation.facts.contains { $0.value == "Lodge" })
        #expect(presentation.facts.contains { $0.value == "kitchen, cast-iron" })
        #expect(presentation.factLine?.contains("Manufacturer: Lodge") == true)
        #expect(presentation.accessibilityText.contains("Manufacturer, Lodge"))
        #expect(!presentation.accessibilityText.contains("PRD-1001"))
    }

    @Test func serverComposedLabelsPrintInsteadOfARederivedFigure() throws {
        let purchase = EntityRow(
            id: "PUR-1001", title: "Order", subtitle: nil, imageURL: nil,
            raw: [
                "id": "PUR-1001", "expenseCount": 4, "expenseCountLabel": "4 · 2 unpriced",
                "reconciliation": "mismatch", "reconciliationLabel": "Needs review -$5.00",
            ])
        let presentation = EntityRowPresentation.resolve(
            descriptor: EntityCatalog[.purchase], row: purchase,
            columns: ["expenseCount", "reconciliation"])
        #expect(presentation.facts.contains { $0.value == "4 · 2 unpriced" })
        #expect(presentation.facts.contains { $0.value == "Needs review -$5.00" })

        // A reference cell names the records it links to, one per element.
        let meal = EntityRow(
            id: "MEL-1001", title: "Supper", subtitle: nil, imageURL: nil,
            raw: [
                "id": "MEL-1001",
                "recipes": [["recipe": ["name": "Soup"]], ["recipe": ["name": "Bread"]]],
            ])
        let mealFacts = EntityRowPresentation.resolve(
            descriptor: EntityCatalog[.meal], row: meal, columns: ["recipes"])
        #expect(mealFacts.facts.contains { $0.value == "Soup, Bread" })
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
            descriptor: descriptor, row: row, columns: ["vendorId", "statedTotal"])

        #expect(presentation.facts.contains { $0.value == "Sample Vendor" })
        #expect(presentation.facts.contains { $0.value == "$0.00" })
        #expect(presentation.factLine?.contains("Vendor: Sample Vendor") == true)
        #expect(presentation.accessibilityText.contains("Vendor, Sample Vendor"))
    }

    @Test func recipeSourcesRenderThroughTheImplementedRenderer() throws {
        let recipe = EntityCatalog[.recipe]
        let book = EntityRow(
            id: "RCP-1001", title: "Soup", subtitle: nil, imageURL: nil,
            raw: [
                "id": "RCP-1001", "name": "Soup",
                "source": ["type": "book", "book": "The Big Book", "cookbookId": "CBK-1"],
            ])
        let website = EntityRow(
            id: "RCP-1002", title: "Soup", subtitle: nil, imageURL: nil,
            raw: [
                "id": "RCP-1002", "name": "Soup",
                "source": ["type": "website", "url": "https://www.example.com/recipe"],
            ])

        #expect(RecipeSourcePresentation.parse(book.raw["source"])?.label == "The Big Book")
        #expect(RecipeSourcePresentation.parse(website.raw["source"])?.label == "example.com")
        #expect(
            EntityRowPresentation.resolve(descriptor: recipe, row: website, columns: ["source"])
                .facts.contains { $0.id == "source" && $0.value == "example.com" }
        )
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
        #expect(presentation.factLine?.contains("Observed on:") == true)
    }

}
