import Foundation
import Testing

@testable import CubbyKit

@Suite("Declared board paging")
struct EntityBoardPlanTests {
    // An empty Inbox must remain a destination for unassigning an existing task.
    @Test func emptyClearableGroupRemainsAvailable() {
        let choice = EntityCatalog[.task].groupChoice("projectId")!
        let empty = EntityBoardPlan.includingNoValueGroup([], choice: choice)
        #expect(empty.map(\.id) == [EntityListSection.noValueKey])
        #expect(empty.first?.label == choice.noValueLabel)
        let existing = [
            EntityListSection(
                id: EntityListSection.noValueKey, label: choice.noValueLabel, count: 3, rows: [])
        ]
        #expect(EntityBoardPlan.includingNoValueGroup(existing, choice: choice).first?.count == 3)
        #expect(EntityBoardPlan.includingNoValueGroup(existing, choice: choice).count == 1)
    }
    // A cap bounds cards, never the full-filter count. Every group starts its own page.
    @Test func completedCardsAreCappedWithoutChangingTheCount() throws {
        let view = EntityCatalog[.task].presentation.listViews.compactMap { view -> BoardListSpec? in
            if case .board(let spec) = view { return spec }; return nil
        }.first!
        #expect(EntityBoardPlan.pageSize(view, groupBy: "status", key: "done") == 20)
        #expect(EntityBoardPlan.pageSize(view, groupBy: "status", key: "blocked") == 50)
        // Capped destination reads must use the same ordering as rendered cards.
        #expect(EntityBoardPlan.sortParameter(view, groupBy: "status", key: "done") == "-updatedAt")
        #expect(
            EntityBoardPlan.sortParameter(view, groupBy: "status", key: "blocked") == "sortOrder,-createdAt")
    }
    // A page's final row is an anchor, not proof that it is the group's final row.
    @Test func moveAndPositionAreOneCommandBody() {
        let body = EntityBoardPlan.drop(
            rows: [["id": "TSK-AAAA"]], id: "TSK-BBBB", before: nil,
            group: ["status": .string("done")], move: true)
        #expect(body["position"]?["after"]?.stringValue == "TSK-AAAA")
        #expect(body["position"]?["before"] == .null)
        #expect(body["position"]?["group"]?["status"]?.stringValue == "done")
        #expect(body["move"]?["patch"]?["status"]?.stringValue == "done")
    }
    @Test func positionKeepsBothNeighborAnchors() {
        let body = EntityBoardPlan.drop(
            rows: [["id": "a"], ["id": "b"]], id: "c", before: "b",
            group: ["projectId": .null])
        #expect(body["position"]?["before"]?.stringValue == "b")
        #expect(body["position"]?["after"]?.stringValue == "a")
        #expect(body["move"] == nil)
    }
}
