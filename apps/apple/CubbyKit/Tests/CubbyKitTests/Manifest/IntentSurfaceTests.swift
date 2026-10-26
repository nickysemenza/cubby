import Testing

@testable import CubbyKit

@Suite("Intent surface")
struct IntentSurfaceTests {
    @Test func productPlacementIsAReadOnlyPathProjection() throws {
        let field = try #require(EntityCatalog[.product].field("primaryPlacement"))
        #expect(field.readPath == "primaryPlacement.path")
        #expect(field.showInList)
    }

    @Test func descriptorForShortcode() {
        #expect(EntityCatalog.descriptor(forShortcode: "PRD-2345")?.key == .product)
        #expect(EntityCatalog.descriptor(forShortcode: "loc-2345")?.key == .location)
        #expect(EntityCatalog.descriptor(forShortcode: "nope") == nil)
    }
}
