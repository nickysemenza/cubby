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

    /// A `createSelf` option is never one of the route-picker's menu rows (see
    /// `PhotoImportManifest.destinationOptions`), but the "New <entity>" row still reuses
    /// `menuTitle` for its label, so the exhaustive `.createSelf` case must read naturally there.
    @Test func createSelfOptionHasANewRecordMenuTitle() throws {
        let route = try #require(PhotoImportCatalog.ingressRoutes.first { $0.id == "task-new" })
        let option = PhotoDestinationOption(route: route, descriptor: EntityCatalog[.task])

        #expect(option.menuTitle == "New Task")
    }

    @Test func everyMoveMenuRouteHasADistinctTitle() throws {
        let manifest = makeManifest(items: [])
        let titles = manifest.destinationOptions.map(\.menuTitle)

        #expect(Set(titles).count == titles.count)
        #expect(titles.contains("Existing Garden Entry for Planting"))
        #expect(titles.contains("New Garden Entry from Planting"))
    }

    @Test func existingRelatedRouteFindsItsManifestDeclaredCreateAlternative() throws {
        let manifest = makeManifest(items: [])
        let existing = try #require(
            manifest.destinationOptions.first { $0.id == "planting-garden-entry" })

        #expect(manifest.createAlternative(for: existing)?.id == "planting-new-garden-entry")
    }

    @Test func sourceTypesExplainTheManifestPrimaryOutcome() throws {
        let manifest = makeManifest(items: [])
        let planting = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let gardenEntry = try #require(
            manifest.sourceTypeOptions.first { $0.source == .gardenEntry })

        #expect(planting.outcomeDescription == "Choose an existing or new Garden Entry")
        #expect(gardenEntry.outcomeDescription == "Attaches to an existing Garden Entry")
    }

    @Test func selectingPlantingCarriesItsRecordIntoTheRoutePickerDestination() throws {
        let manifest = makeManifest(items: [])
        let planting = try #require(manifest.sourceTypeOptions.first { $0.source == .planting })
        let curryLeaf = EntityRow(
            id: "PLT-CJK7", title: "curry leaf", subtitle: nil, imageURL: nil,
            raw: .object(["id": .string("PLT-CJK7")]))

        #expect(
            PhotoImportNavigationDestination.sourceSelection(
                type: planting, row: curryLeaf)
                == .routePicker(source: .planting, row: curryLeaf))
    }
}
