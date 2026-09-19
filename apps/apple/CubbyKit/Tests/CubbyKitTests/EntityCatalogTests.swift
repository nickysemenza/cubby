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
        let pattern = /^[A-Z]{2,5}-$/
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

    /// `timeline` is emitted from the declaration's capability; the route from the HTTP
    /// document. The two generators must agree or a timeline view would render without a route.
    @Test func timelineModeMatchesTheTimelineRoute() {
        for descriptor in EntityCatalog.all {
            #expect(
                (descriptor.timeline != nil) == descriptor.key.nativeActions.contains(.timeline),
                Comment(rawValue: "\(descriptor.key) timeline mode and route disagree"))
        }
    }

    /// A field in a create/update roster is only reachable through the matching generated op.
    @Test func editableRostersHaveAGeneratedOperation() {
        for descriptor in EntityCatalog.all {
            if descriptor.fields.contains(where: \.inCreate) {
                #expect(
                    descriptor.key.nativeActions.contains(.create),
                    Comment(rawValue: "\(descriptor.key) create"))
            }
            if descriptor.fields.contains(where: \.inUpdate) {
                #expect(
                    descriptor.key.nativeActions.contains(.update),
                    Comment(rawValue: "\(descriptor.key) update"))
            }
        }
    }

    /// Every declared relation section binds a many-relation to an id filter on the target that
    /// points back at the source — the facts `RelationSectionModel` reads.
    @Test func relationSectionsResolveOnTheTarget() {
        for descriptor in EntityCatalog.all {
            for section in descriptor.presentation.detailSections {
                guard case .relation(let spec) = section.kind else { continue }
                let relation = descriptor.relation(spec.relation)
                #expect(relation?.cardinality == .many, Comment(rawValue: "\(descriptor.key).\(section.id)"))
                guard let relation else { continue }
                let filter = EntityCatalog[relation.target].filter(spec.filterDescriptor)
                #expect(
                    filter?.targetEntity == descriptor.key,
                    Comment(rawValue: "\(descriptor.key).\(section.id)"))
                #expect(filter.map { $0.kind == .id || $0.kind == .idMulti } == true)
            }
        }
    }
}
