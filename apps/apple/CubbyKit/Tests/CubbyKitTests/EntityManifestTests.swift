import Foundation
import Testing

@testable import CubbyKit

/// `EntityCatalog.all` decodes the bundled `entity-manifest.json` on first use and traps when it
/// cannot, so a manifest the descriptor types in `Catalog/EntityManifest.swift` do not decode
/// fails here, in CI, instead of at app launch.
@Suite("EntityManifest")
struct EntityManifestTests {
    @Test func suggestionMetadataDecodesAlongsideOlderFields() throws {
        let field = try JSONDecoder().decode(
            FieldDescriptor.self,
            from: Data(
                #"{"key":"evidenceExpectation","label":"Receipt expectation","kind":"enum","nullable":true,"suggestion":{"basis":["name","notes"],"mode":"fill"},"inCreate":true,"requiredOnCreate":false,"inUpdate":true,"showInList":false,"showInDetail":true,"listHidden":false,"mobileInteractive":false}"#
                    .utf8))
        #expect(field.suggestion?.basis == ["name", "notes"])
        #expect(field.suggestion?.mode == "fill")
        let old = try JSONDecoder().decode(
            FieldDescriptor.self,
            from: Data(
                #"{"key":"name","label":"Name","kind":"text","nullable":false,"inCreate":true,"requiredOnCreate":true,"inUpdate":true,"showInList":true,"showInDetail":true,"listHidden":false,"mobileInteractive":false}"#
                    .utf8))
        #expect(old.suggestion == nil)
    }

    @Test func bundledManifestDecodesOneDescriptorPerEntityKey() {
        let keys = EntityCatalog.all.map(\.key)
        #expect(keys.count == EntityKey.allCases.count)
        #expect(Set(keys) == Set(EntityKey.allCases))
    }
}
