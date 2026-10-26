import CubbyKit
import Testing

@testable import Cubby

@MainActor
@Suite("Audit intent surface")
struct AuditIntentSurfaceTests {
    @Test func cookIntentRejectsANonRecipe() async throws {
        var intent = CookRecipeIntent()
        intent.recipe = CubbyEntity(
            row: EntityRow(id: "PRD-2345", title: "Synthetic Jar", subtitle: nil, imageURL: nil, raw: .null),
            kind: .product)

        await #expect(throws: (any Error).self) {
            try await intent.perform()
        }
    }

    @Test func nonLocationPickRequiresAnotherValueBeforeOpeningAudit() async throws {
        var intent = StartAuditIntent()
        intent.location = CubbyEntity(
            row: EntityRow(id: "PRD-2345", title: "Jar", subtitle: nil, imageURL: nil, raw: .null),
            kind: .product)

        await #expect(throws: (any Error).self) {
            try await intent.perform()
        }
    }
}
