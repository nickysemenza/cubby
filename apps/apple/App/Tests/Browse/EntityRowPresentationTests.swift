import CubbyKit
import Foundation
import Testing

@testable import Cubby

@Suite("Entity row presentation")
struct EntityRowPresentationTests {
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
        #expect(presentation.facts.map(\.id) == ["tags", "manufacturer"])
        #expect(presentation.facts.contains { $0.value == "Lodge" })
        #expect(presentation.facts.contains { $0.value == "kitchen, cast-iron" })
        #expect(presentation.factLine?.contains("Manufacturer: Lodge") == true)
        #expect(presentation.accessibilityText.contains("Manufacturer, Lodge"))
        #expect(!presentation.accessibilityText.contains("PRD-1001"))
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

    @Test func generatedPresentationCoverageAndRecipeSourcesStayExplicit() throws {
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

        for renderer in ControlRendererID.allCases {
            let status = NativePresentationCoverage.control(renderer)
            if renderer == .structuredField {
                #expect(status == .unsupported("Structured fields are available on web."))
            } else {
                #expect(!status.isUnsupported)
            }
        }
        for renderer in ListRendererID.allCases {
            #expect(NativePresentationCoverage.list(renderer) == .implemented)
        }
        #expect(NativePresentationCoverage.detail(.recipeSource) == .implemented)
        #expect(NativePresentationCoverage.detail(.productExternalIds) == .generic)
        #expect(NativePresentationCoverage.detail(.recipeMeta).isUnsupported)

        let declaredDetailSlots = EntityCatalog.all.flatMap { descriptor in
            descriptor.presentation.detailSections.compactMap { section in
                if case .slot = section.kind { return section.id }
                return nil
            }
        }
        #expect(
            Set(declaredDetailSlots).allSatisfy {
                NativePresentationCoverage.detailSlot($0)
                    != .unsupported("Unknown native detail slot.")
            }
        )
        #expect(NativePresentationCoverage.detailSlot("meal.nutrition") == .implemented)
        #expect(NativePresentationCoverage.detailSlot("meal.composition").isUnsupported)
        #expect(NativePresentationCoverage.detailSlot("nutrition").isUnsupported)

        let declaredListSlots = EntityCatalog.all.flatMap { descriptor in
            descriptor.presentation.listViews.compactMap { view in
                if case .slot(let id, _, _) = view { return id }
                return nil
            }
        }
        #expect(
            Set(declaredListSlots).allSatisfy {
                NativePresentationCoverage.listSlot($0) == .ownedElsewhere
            }
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
        #expect(presentation.factLine?.contains("Observed:") == true)
    }

}
