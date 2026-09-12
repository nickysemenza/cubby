import Foundation
import Testing

@testable import CubbyKit

@Suite("EntityCatalog")
struct EntityCatalogTests {
    @Test func everyKeyHasADescriptor() {
        for key in EntityKey.allCases {
            let descriptor = EntityCatalog[key]
            #expect(descriptor.key == key)
        }
    }

    @Test func basePathsAreUniqueAndNonEmpty() {
        let basePaths = EntityCatalog.all.map(\.basePath)
        for basePath in basePaths {
            #expect(!basePath.isEmpty)
        }
        #expect(basePaths.count == Set(basePaths).count)
    }

    @Test func shortcodePrefixesAreUniqueAndWellFormed() {
        let prefixes = EntityCatalog.all.compactMap(\.shortcodePrefix)
        let pattern = /^[A-Z]{3}-$/
        for prefix in prefixes {
            #expect(prefix.wholeMatch(of: pattern) != nil, "unexpected shortcode prefix shape: \(prefix)")
        }
        #expect(prefixes.count == Set(prefixes).count)
    }

    @Test func titleFieldsAreNonEmpty() {
        for descriptor in EntityCatalog.all {
            #expect(!descriptor.titleField.isEmpty)
        }
    }

    @Test func listableDescriptorsHaveANonEmptyBasePath() {
        for descriptor in EntityCatalog.all where descriptor.actions.contains(.list) {
            #expect(!descriptor.basePath.isEmpty)
        }
    }
}
