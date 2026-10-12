import Testing

@testable import CubbyKit

@Suite("Intent surface")
struct IntentSurfaceTests {
    @Test func descriptorForShortcode() {
        #expect(EntityCatalog.descriptor(forShortcode: "PRD-2345")?.key == .product)
        #expect(EntityCatalog.descriptor(forShortcode: "loc-2345")?.key == .location)
        #expect(EntityCatalog.descriptor(forShortcode: "nope") == nil)
    }
}
