import CubbyKit
import Foundation
import Testing

@testable import Cubby

@MainActor
@Suite("Audit intent surface", .serialized)
struct AuditIntentSurfaceTests {
    @Test func captureControlOpensCaptureAndPreservesTheOtherTabsHistory() async throws {
        let previous = AppModel.active
        defer { AppModel.active = previous }
        let model = AppModel.preview(signedIn: false, baseURL: URL(string: "https://cubby.example.com")!)
        AppModel.active = model
        model.navigator.section = .search
        model.navigator.paths[.search] = [.entityDetail(.product, id: "PRD-ABCD")]
        model.navigator.paths[.capture] = [.identify]

        _ = try await OpenCaptureControlIntent().perform()

        #expect(model.navigator.section == .capture)
        #expect(model.navigator.paths[.capture] == [])
        #expect(model.navigator.paths[.search] == [.entityDetail(.product, id: "PRD-ABCD")])
    }

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
