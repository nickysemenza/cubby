import Testing

@testable import CubbyKit

@Suite("ActionPlacement")
struct ActionPlacementTests {
    @Test func disabledServerVerbStaysInDetailButLeavesRowActions() {
        let placement = ActionPlacement(
            entity: EntityCatalog[.task], raw: [:],
            availability: [ActionAvailability(id: "complete", enabled: false, reason: "Blocked")])
        #expect(placement.rowCommand == nil)
        #expect(!placement.leadingSwipe.contains { $0.id == "complete" })
        #expect(placement.actionBar.first { $0.id == "complete" }?.reason == "Blocked")
        #expect(placement.more.flatMap { $0 }.first { $0.id == "complete" }?.enabled == false)
    }

    @Test func serverEnabledCommandAndQuickFieldsAreProjected() {
        let placement = ActionPlacement(
            entity: EntityCatalog[.task], raw: [:],
            availability: [ActionAvailability(id: "complete", enabled: true)])
        #expect(placement.rowCommand?.id == "complete")
        #expect(placement.leadingSwipe.first?.id == "complete")
        #expect(placement.actionBar.count <= 4)
        #expect(placement.actionBar.contains { $0.id == "status" && $0.isQuickField })
        #expect(placement.more.last?.last?.id == "delete")
    }
}
