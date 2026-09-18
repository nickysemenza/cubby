import CubbyKit
import Testing

@testable import Cubby

@MainActor
@Suite("Photo destination options")
struct PhotoDestinationOptionTests {
    @Test func rowsHaveManifestIdentityAndRouteSpecificTitles() throws {
        let createRoute = try #require(
            PhotoImportCatalog.ingressRoutes.first { $0.id == "recipe-new-meal" })
        let selfRoute = try #require(
            PhotoImportCatalog.ingressRoutes.first { $0.id == "meal-self" })
        let descriptor = EntityCatalog[.meal]
        let create = PhotoDestinationOption(route: createRoute, descriptor: descriptor)
        let existing = PhotoDestinationOption(route: selfRoute, descriptor: descriptor)

        #expect(create.id != existing.id)
        #expect(create.menuTitle == "New Meal from Recipe")
        #expect(
            create.menuTitle(
                for: EntityRow(
                    id: "RCP-ABCD", title: "Soup", subtitle: nil, imageURL: nil,
                    raw: .object([:]))) == "Create Meal for RCP-ABCD")
        #expect(existing.title == "Meals")
    }

    @Test func everyMoveMenuRouteHasADistinctTitle() throws {
        let manifest = PhotoImportManifest(items: [])
        let titles = manifest.destinationOptions.map(\.menuTitle)

        #expect(Set(titles).count == titles.count)
        #expect(titles.contains("Existing Garden Entry for Planting"))
        #expect(titles.contains("New Garden Entry from Planting"))
    }

    @Test func existingRelatedRouteFindsItsManifestDeclaredCreateAlternative() throws {
        let manifest = PhotoImportManifest(items: [])
        let existing = try #require(
            manifest.destinationOptions.first { $0.id == "planting-garden-entry" })

        #expect(manifest.createAlternative(for: existing)?.id == "planting-new-garden-entry")
    }

    @Test func sourceTypesExplainTheManifestPrimaryOutcome() throws {
        let manifest = PhotoImportManifest(items: [])
        let planting = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let gardenEntry = try #require(
            manifest.sourceTypeOptions.first { $0.source == .gardenEntry })

        #expect(planting.outcomeDescription == "Choose an existing or new Garden Entry")
        #expect(gardenEntry.outcomeDescription == "Attaches to an existing Garden Entry")
    }
}
