import Testing

@testable import CubbyKit

/// `EntityCatalog.all` decodes the bundled `entity-manifest.json` on first use and traps when it
/// cannot, so a manifest the hand-written types in `Catalog/EntityManifest.swift` do not decode
/// fails here, in CI, instead of at app launch.
@Suite("EntityManifest")
struct EntityManifestTests {
    @Test func bundledManifestDecodesOneDescriptorPerEntityKey() {
        let keys = EntityCatalog.all.map(\.key)
        #expect(keys.count == EntityKey.allCases.count)
        #expect(Set(keys) == Set(EntityKey.allCases))
    }
}
