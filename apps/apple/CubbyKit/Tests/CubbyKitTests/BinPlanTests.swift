import Testing

@testable import CubbyKit

/// Port of `sweep-bin-plan.unit.test.ts` over the fixture tree:
/// Home > Garage > Shelf A > Bin 1 > Bin 2; Home > Kitchen > Bin 9; Unknown (a second root).
@Suite("BinPlan")
struct BinPlanTests {
    let tree = try! LocationTreeTests.tree()
    let home = LocationCode("LOC-2345")
    let garage = LocationCode("LOC-3456")
    let shelf = LocationCode("LOC-4567")
    let bin1 = LocationCode("LOC-5678")
    let bin2 = LocationCode("LOC-6789")
    let bin9 = LocationCode("LOC-89AB")

    @Test func confirmsADirectChild() {
        #expect(BinPlan.plan(scanned: bin1, anchor: shelf, in: tree) == .confirm)
    }

    /// The sharpest edge of the direct-membership rule: one level deeper is NOT here.
    @Test func offersAGrandchildForPromotion() {
        #expect(
            BinPlan.plan(scanned: bin2, anchor: shelf, in: tree)
                == .adopt(AdoptableBin(id: bin2, name: "Bin 2", type: "box", currentParentName: "Bin 1"))
        )
    }

    @Test func offersABinFromAnotherBranchNamingWhereItSits() {
        #expect(
            BinPlan.plan(scanned: bin9, anchor: shelf, in: tree)
                == .adopt(AdoptableBin(id: bin9, name: "Bin 9", type: "bag", currentParentName: "Kitchen"))
        )
    }

    @Test func refusesTheBinBeingCounted() {
        #expect(
            BinPlan.plan(scanned: shelf, anchor: shelf, in: tree)
                == .refuse(reason: .self, message: "That's Shelf A — the one you're counting."))
    }

    @Test func refusesAncestorsAsCycles() {
        #expect(
            BinPlan.plan(scanned: garage, anchor: shelf, in: tree)
                == .refuse(reason: .ancestor, message: "Garage contains Shelf A — it can't move inside it."))
        #expect(
            BinPlan.plan(scanned: garage, anchor: bin2, in: tree)
                == .refuse(reason: .ancestor, message: "Garage contains Bin 2 — it can't move inside it."))
    }

    /// Pins the check order: Home is an ancestor of nearly everything.
    @Test func reportsARootAsARootEvenThoughItIsAlsoAnAncestor() {
        #expect(
            BinPlan.plan(scanned: home, anchor: shelf, in: tree)
                == .refuse(reason: .root, message: "Home holds the whole house — it can't sit on a shelf."))
    }

    @Test func letsHomeItselfBeCounted() {
        if case .adopt = BinPlan.plan(scanned: bin1, anchor: home, in: tree) {
        } else {
            Issue.record("expected adopt")
        }
    }

    @Test func refusesALabelOutsideTheTree() {
        if case .refuse(.unknownLabel, _) = BinPlan.plan(
            scanned: LocationCode("LOC-ZZZZ"), anchor: shelf, in: tree)
        {
        } else {
            Issue.record("expected unknownLabel")
        }
    }

    /// Shared with `sweep-bin-plan.unit.test.ts` (`packages/shared/golden-vectors/bin-plan.json`):
    /// the verdict, reason and copy must agree with the web module this file ports.
    @Test func matchesTheSharedGoldenVectors() throws {
        struct Node: Decodable {
            let code: String
            let name: String
            let parent: String?
        }
        struct Case: Decodable {
            let anchor: String
            let scanned: String
            let verdict: String
            let reason: String?
            let message: String?
            let adoptName: String?
            let currentParentName: String?
        }
        struct File: Decodable {
            let nodes: [Node]
            let cases: [Case]
        }
        let file = try GoldenVectors.decode(File.self, named: "bin-plan")

        func json(_ node: Node) -> [String: Any] {
            [
                "id": node.code, "name": node.name, "aliases": [String](), "tags": [String](),
                "type": node.parent == nil ? "house" : "box", "product": NSNull(),
                "lastBulkInventory": NSNull(), "aiDescription": NSNull(), "images": [String](),
                "valuation": NSNull(), "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z", "childCount": 0, "directItemCount": 0,
                "totalItemCount": 0,
                "children": file.nodes.filter { $0.parent == node.code }.map(json),
            ]
        }
        let roots = file.nodes.filter { $0.parent == nil }.map(json)
        let data = try JSONSerialization.data(withJSONObject: roots)
        let tree = LocationTree(roots: try JSONDecoder.cubby().decode([LocationTreeNode].self, from: data))

        for c in file.cases {
            let verdict = BinPlan.plan(
                scanned: LocationCode(c.scanned), anchor: LocationCode(c.anchor), in: tree)
            switch (c.verdict, verdict) {
            case ("confirm", .confirm):
                break
            case ("adopt", .adopt(let bin)):
                #expect(bin.name == c.adoptName, "\(c.anchor) <- \(c.scanned)")
                #expect(bin.currentParentName == c.currentParentName, "\(c.anchor) <- \(c.scanned)")
            case ("refuse", .refuse(let reason, let message)):
                let label: String
                switch reason {
                case .self: label = "self"
                case .root: label = "root"
                case .ancestor: label = "ancestor"
                case .unknownLabel: label = "unknownLabel"
                }
                #expect(label == c.reason, "\(c.anchor) <- \(c.scanned)")
                #expect(message == c.message?.replacingOccurrences(of: "{verb}", with: "counting"))
            default:
                Issue.record("\(c.anchor) <- \(c.scanned): expected \(c.verdict), got \(verdict)")
            }
        }
    }
}
