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
}
