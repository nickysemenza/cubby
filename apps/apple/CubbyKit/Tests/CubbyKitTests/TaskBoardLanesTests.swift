import Foundation
import Testing

@testable import CubbyKit

/// The native board names its lanes the way web's board does: a project by its name (never its
/// shortcode), no project as "Inbox", a trade by its declared label.
@Suite("TaskBoardLanes")
struct TaskBoardLanesTests {
    private static func task(
        _ id: String, status: String = "not_started", project: (String, String)? = nil,
        trade: String = "general"
    ) -> JSONValue {
        var raw: [String: JSONValue] = [
            "id": .string(id), "status": .string(status), "trade": .string(trade),
        ]
        if let project {
            raw["projectId"] = .string(project.0)
            raw["projectName"] = .string(project.1)
        } else {
            raw["projectId"] = .null
            raw["projectName"] = .null
        }
        return .object(raw)
    }

    @Test func aProjectLaneIsTitledByNameNotShortcode() {
        let lane = TaskBoardLanes.lane(
            of: Self.task("TSK-1", project: ("PRJ-4K7M", "Attic insulation")), axis: .project)
        #expect(lane.value == "PRJ-4K7M")
        #expect(lane.title == "Attic insulation")
    }

    @Test func aTaskWithNoProjectLandsInTheInboxLane() {
        let lane = TaskBoardLanes.lane(of: Self.task("TSK-1"), axis: .project)
        #expect(lane.value == nil)
        #expect(lane.title == "Inbox")
    }

    @Test func aNamelessProjectIsNamedForTheUser() {
        var raw = Self.task("TSK-1", project: ("PRJ-4K7M", "x"))
        raw = .object(raw.objectValue!.merging(["projectName": .null]) { $1 })
        #expect(TaskBoardLanes.lane(of: raw, axis: .project).title == "Untitled project")
    }

    @Test func projectLanesPutTheInboxFirstThenNamesAlphabetically() {
        let tasks = [
            Self.task("TSK-1", project: ("PRJ-2", "Garage")),
            Self.task("TSK-2", project: ("PRJ-1", "Attic")),
            Self.task("TSK-3", project: ("PRJ-2", "Garage")),
        ]
        let lanes = TaskBoardLanes.destinations(of: tasks, axis: .project)
        #expect(lanes.map(\.title) == ["Inbox", "Attic", "Garage"])
        #expect(lanes.map(\.value) == [nil, "PRJ-1", "PRJ-2"])
    }

    @Test func groupsHoldOnlyLanesWithTasksInLaneOrder() {
        let tasks = [
            Self.task("TSK-1", project: ("PRJ-2", "Garage")),
            Self.task("TSK-2"),
            Self.task("TSK-3", project: ("PRJ-2", "Garage")),
        ]
        let groups = TaskBoardLanes.groups(of: tasks, axis: .project)
        #expect(groups.map(\.lane.title) == ["Inbox", "Garage"])
        #expect(groups.map(\.tasks.count) == [1, 2])
    }

    @Test func aFinishedProjectDoesNotKeepALane() {
        let tasks = [
            Self.task("TSK-1", status: "done", project: ("PRJ-1", "Attic")),
            Self.task("TSK-2", project: ("PRJ-2", "Garage")),
        ]
        #expect(
            TaskBoardLanes.destinations(of: tasks, axis: .project).map(\.title) == ["Inbox", "Garage"])
    }

    @Test func tradeLanesUseTheDeclaredLabelsInCatalogOrder() throws {
        let options = try #require(EntityCatalog[.task].field("trade")?.controlOptions)
        let first = try #require(options.first)
        let last = try #require(options.last)
        let tasks = [Self.task("TSK-1", trade: last.value), Self.task("TSK-2", trade: first.value)]
        let lanes = TaskBoardLanes.destinations(of: tasks, axis: .trade)
        #expect(lanes.map(\.title) == [first.label, last.label])
        #expect(lanes.map(\.value) == [first.value, last.value])
    }
}
