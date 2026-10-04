import Foundation
import Testing

@testable import CubbyKit

/// Shared with `packages/shared/src/collection-tag.unit.test.ts`: web's `ProductTagsField` and the
/// native tags control split a product's one `tags` list into Tags and Collections by the same
/// rule (`packages/shared/golden-vectors/collection-tag.json`).
@Suite("CollectionTag")
struct CollectionTagTests {
    private struct Split: Decodable {
        let tags: [String]
        let tagsOut: [String]
        let collections: [String]
    }
    private struct Merge: Decodable {
        let tags: [String]
        let collections: [String]
        let out: [String]
    }
    private struct Normalize: Decodable {
        let `in`: String
        let out: String
    }
    private struct File: Decodable {
        let split: [Split]
        let merge: [Merge]
        let normalize: [Normalize]
    }

    private func vectors() throws -> File {
        try GoldenVectors.decode(File.self, named: "collection-tag")
    }

    @Test func splitMatchesTheSharedVectors() throws {
        for vector in try vectors().split {
            let split = CollectionTag.split(vector.tags)
            #expect(split.tags == vector.tagsOut, "\(vector.tags)")
            #expect(split.collections == vector.collections, "\(vector.tags)")
        }
    }

    @Test func mergeMatchesTheSharedVectors() throws {
        for vector in try vectors().merge {
            #expect(
                CollectionTag.merge(tags: vector.tags, collections: vector.collections) == vector.out,
                "\(vector.collections)")
        }
    }

    @Test func normalizeMatchesTheSharedVectors() throws {
        for vector in try vectors().normalize {
            #expect(CollectionTag.normalizedSlug(vector.in) == vector.out, "\(vector.in)")
        }
    }

}
