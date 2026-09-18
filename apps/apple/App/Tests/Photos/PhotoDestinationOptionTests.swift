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
        #expect(existing.title == "Meals")
    }
}
