import Foundation
import Testing

@testable import CubbyKit

@Suite("LocationTree")
struct LocationTreeTests {
    static func tree() throws -> LocationTree {
        LocationTree(roots: try Fixtures.decode(SuccessEnvelope<[LocationTreeNode]>.self, from: "location-tree.json").data)
    }

    @Test func decodesTheRecursiveNodeAndIndexesParents() throws {
        let tree = try Self.tree()
        #expect(tree.count == 8)
        #expect(tree[LocationCode("LOC-5678")]?.name == "Bin 1")
        #expect(tree.parent(of: LocationCode("LOC-5678"))?.id == LocationCode("LOC-4567"))
        #expect(tree.isRoot(LocationCode("LOC-2345")))
        #expect(tree.isRoot(LocationCode("LOC-9ABC")))
        #expect(!tree.isRoot(LocationCode("LOC-3456")))
        #expect(tree[LocationCode("LOC-4567")]?.lastBulkInventoryRaw == "2026-08-01T12:00:00.000Z")
    }

    @Test func ancestorsAndBreadcrumb() throws {
        let tree = try Self.tree()
        #expect(tree.ancestors(of: LocationCode("LOC-6789")).map(\.name) == ["Bin 1", "Shelf A", "Garage", "Home"])
        #expect(tree.breadcrumb(of: LocationCode("LOC-6789")).map(\.name) == ["Home", "Garage", "Shelf A", "Bin 1", "Bin 2"])
        #expect(tree.isDescendant(LocationCode("LOC-6789"), of: LocationCode("LOC-3456")))
        #expect(!tree.isDescendant(LocationCode("LOC-3456"), of: LocationCode("LOC-6789")))
        #expect(tree.breadcrumb(of: LocationCode("LOC-ZZZZ")).isEmpty)
    }

    /// Shelf A holds nothing directly, so it is not a stop; its stocked descendants are.
    @Test func auditableBinsAreStockedNodesDepthFirst() throws {
        let tree = try Self.tree()
        #expect(tree.auditableBins(under: LocationCode("LOC-3456")).map(\.name) == ["Garage", "Bin 1", "Bin 2"])
        #expect(tree.auditableBins(under: LocationCode("LOC-4567")).map(\.name) == ["Bin 1", "Bin 2"])
        #expect(tree.auditableBins(under: LocationCode("LOC-9ABC")).isEmpty)
    }

    @Test func scopeCandidatesSkipTheEmptyUnknown() throws {
        let tree = try Self.tree()
        let candidates = tree.scopeCandidates()
        #expect(candidates.map(\.node.name) == ["Home", "Garage", "Shelf A", "Bin 1", "Bin 2", "Kitchen", "Bin 9"])
        #expect(candidates.map(\.depth) == [0, 1, 2, 3, 4, 1, 2])
    }
}
