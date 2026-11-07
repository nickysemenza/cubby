import Testing

@testable import CubbyKit

@Suite("ActionPlacement")
struct ActionPlacementTests {
    private func ids(_ actions: [PlacedAction]) -> [String] { actions.map(\.id) }

    @Test func serverRefusalHidesRowActionsButDimsDetailTiles() {
        let placement = ActionPlacement(
            entity: EntityCatalog[.task], raw: [:],
            availability: [ActionAvailability(id: "complete", enabled: false, reason: "Blocked")])
        #expect(!ids(placement.leadingSwipe).contains("complete"))
        #expect(!placement.contextMenu.joined().contains { $0.id == "complete" })
        // The row command keeps its column, dimmed, so rows stay aligned.
        #expect(placement.rowCommand?.enabled == false)
        let tile = placement.actionBar.first { $0.id == "complete" }
        #expect(tile?.reason == "Blocked" && tile?.prominence == .filled)
        #expect(placement.more.joined().first { $0.id == "complete" }?.enabled == false)
    }

    @Test func detailBarNeverHoldsDestructiveVerbsAndDeleteComesLast() {
        let placement = ActionPlacement(
            entity: EntityCatalog[.task], raw: [:],
            availability: [ActionAvailability(id: "complete", enabled: true)])
        #expect(placement.rowCommand?.id == "complete")
        #expect(placement.leadingSwipe.first?.id == "complete")
        #expect(placement.actionBar.count <= 4)
        #expect(!placement.actionBar.contains { $0.isDestructive })
        #expect(placement.actionBar.contains { $0.kind == .quickField("status") })
        #expect(placement.more.last?.last?.id == "delete")
        #expect(placement.trailingSwipe.first?.id == "delete")
        #expect(placement.contextMenu.last?.allSatisfy { $0.isDestructive } == true)
    }

    @Test func absentServerAvailabilityFallsBackToTheDeclaredRequirement() {
        // An Expense with no Product cannot be received: dimmed with the plan's reason in detail,
        // absent from the row's swipe.
        let unlinked = ActionPlacement(entity: EntityCatalog[.expense], raw: ["id": "EXP-1"])
        let tile = unlinked.actionBar.first { $0.id == "receive" }
        #expect(tile?.enabled == false && tile?.reason != nil)
        #expect(!ids(unlinked.leadingSwipe).contains("receive"))
        let linked = ActionPlacement(
            entity: EntityCatalog[.expense], raw: ["id": "EXP-1", "productId": "PRD-1"])
        #expect(linked.rowCommand?.enabled == true)
        #expect(linked.leadingSwipe.first?.id == "receive")
    }

    @Test func recordHandoffAppliesOnlyWhereItsConditionsHold() {
        let entity = EntityCatalog[.financialTransaction]
        let booked = ActionPlacement(entity: entity, raw: ["status": "posted", "kind": "purchase"])
        #expect(booked.sectionHandoffs["overview"]?.map(\.id) == ["reviewBooking"])
        #expect(booked.more.joined().contains { $0.id == "reviewBooking" })
        for raw: JSONValue in [
            ["status": "void", "kind": "purchase"], ["status": "posted", "kind": "account_transfer"],
        ] {
            #expect(ActionPlacement(entity: entity, raw: raw).sectionHandoffs.isEmpty)
        }
        let location = ActionPlacement(entity: EntityCatalog[.location], raw: [:])
        #expect(location.actionBar.contains { $0.id == "photoPass" })
    }

    @Test func selectionBarCarriesBulkVerbsAndDimsOnAnyRefusingRow() {
        let task = EntityCatalog[.task]
        let open = task.row(from: ["id": "TSK-1"])!
        let bar = ActionPlacement.selectionBar(entity: task, rows: [open])
        #expect(bar.contains { $0.id == "complete" && $0.enabled })
        #expect(bar.last?.id == "delete")
        let refused = task.row(from: [
            "id": "TSK-2", "actions": [["id": "complete", "enabled": false, "reason": "Blocked"]],
        ])!
        let mixed = ActionPlacement.selectionBar(entity: task, rows: [open, refused])
        #expect(mixed.first { $0.id == "complete" }?.reason == "Blocked")
    }
}
