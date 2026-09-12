import Testing

@testable import CubbyKit

@Suite("Intent surface")
struct IntentSurfaceTests {
    /// `search.find`'s `entityTypes` enum in the OpenAPI document, copied here so a catalog
    /// change that exposes a kind the server cannot search fails loudly.
    static let searchableTypes: Set<String> = [
        "product", "recipe", "ingredient", "cookbook", "location", "inventory", "meal", "project",
        "task", "vendor", "purchase", "financialAccount", "financialTransaction", "wish", "expense",
    ]

    @Test func exposedEntitiesAreSearchableFetchableAndPrefixed() {
        let exposed = EntityCatalog.intentExposed
        #expect(exposed.count == 14)
        #expect(exposed.allSatisfy { $0.shortcodePrefix != nil && $0.actions.contains(.get) && $0.actions.contains(.search) })
        #expect(Set(exposed.map(\.key.rawValue)).isSubset(of: Self.searchableTypes))
        #expect(exposed.contains { $0.key == .product })
        #expect(exposed.contains { $0.key == .location })
        // No search route, so not offered to Siri even though it has a prefix.
        #expect(!exposed.contains { $0.key == .image })
        #expect(!exposed.contains { $0.key == .usdaFood })
    }

    @Test func descriptorForShortcode() {
        #expect(EntityCatalog.descriptor(forShortcode: "PRD-2345")?.key == .product)
        #expect(EntityCatalog.descriptor(forShortcode: "loc-2345")?.key == .location)
        #expect(EntityCatalog.descriptor(forShortcode: "nope") == nil)
    }
}
