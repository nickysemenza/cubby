import Testing

@testable import CubbyKit

@Suite("Intent surface")
struct IntentSurfaceTests {
    /// The intent surface is exactly the catalog's searchable, HTTP-gettable, prefixed entities:
    /// searchable images participate through their native read adapter; entities without a
    /// shortcode prefix (usdaFood) stay out of Siri, Spotlight and deep links.
    @Test func exposedEntitiesAreSearchableFetchableAndPrefixed() {
        let exposed = EntityCatalog.intentExposed
        #expect(exposed.contains { $0.key == .product })
        #expect(exposed.contains { $0.key == .location })
        #expect(exposed.contains { $0.key == .image })
        #expect(!exposed.contains { $0.key == .usdaFood })
    }

    @Test func descriptorForShortcode() {
        #expect(EntityCatalog.descriptor(forShortcode: "PRD-2345")?.key == .product)
        #expect(EntityCatalog.descriptor(forShortcode: "loc-2345")?.key == .location)
        #expect(EntityCatalog.descriptor(forShortcode: "nope") == nil)
    }
}
