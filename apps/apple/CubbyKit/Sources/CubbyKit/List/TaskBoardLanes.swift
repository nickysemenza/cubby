import Foundation

/// One swimlane of the task board: the raw value a drop writes (`projectId` / `trade`; `nil` is
/// the Inbox, a task with no project) and the title the lane shows.
public struct TaskBoardLane: Hashable, Sendable, Identifiable {
    public enum Axis: String, Sendable {
        case project = "projectId"
        case trade = "trade"
    }

    public let axis: Axis
    public let value: String?
    public let title: String

    public var id: String { "\(axis.rawValue):\(value ?? "")" }
}

/// Names board lanes the way web's board does, from fields the board rows already carry: a
/// project by its `projectName` (the row's reference label, never the shortcode), no project as
/// the Inbox, a trade by the catalog's declared option label.
public enum TaskBoardLanes {
    /// The lane a task sits in on `axis`.
    public static func lane(of task: JSONValue, axis: TaskBoardLane.Axis) -> TaskBoardLane {
        switch axis {
        case .project:
            guard let id = task["projectId"]?.stringValue, !id.isEmpty else { return inbox }
            let name = task["projectName"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            return TaskBoardLane(
                axis: .project, value: id,
                title: name ?? SharedConstants.taskBoardUntitledProjectLabel)
        case .trade:
            let trade = task["trade"]?.stringValue
            return TaskBoardLane(
                axis: .trade, value: trade,
                title: trade.flatMap(tradeLabel) ?? trade ?? "Unassigned")
        }
    }

    /// Every lane a task could move to: the Inbox first, then projects by name; trades in the
    /// catalog's order. Derived from the tasks that are not done, so a long-finished project
    /// does not keep a lane.
    public static func destinations(of tasks: [JSONValue], axis: TaskBoardLane.Axis) -> [TaskBoardLane] {
        let active = tasks.filter { $0["status"]?.stringValue != "done" }
        let present = ordered(Set(active.map { lane(of: $0, axis: axis) }), axis: axis)
        return axis == .project ? [inbox] + present.filter { $0.value != nil } : present
    }

    /// The tasks shown on one board page grouped by lane, in lane order; a lane with no task
    /// here is absent.
    public static func groups(of tasks: [JSONValue], axis: TaskBoardLane.Axis)
        -> [(lane: TaskBoardLane, tasks: [JSONValue])]
    {
        let byLane = Dictionary(grouping: tasks) { lane(of: $0, axis: axis) }
        return ordered(Set(byLane.keys), axis: axis).map { ($0, byLane[$0] ?? []) }
    }

    /// The Inbox before named projects (alphabetical), trades in the catalog's order.
    private static func ordered(_ lanes: Set<TaskBoardLane>, axis: TaskBoardLane.Axis) -> [TaskBoardLane] {
        switch axis {
        case .project:
            return lanes.sorted {
                if ($0.value == nil) != ($1.value == nil) { return $0.value == nil }
                return $0.title.localizedStandardCompare($1.title) == .orderedAscending
            }
        case .trade:
            let order = tradeOptions.map(\.value)
            return lanes.sorted {
                (order.firstIndex(of: $0.value ?? "") ?? .max)
                    < (order.firstIndex(of: $1.value ?? "") ?? .max)
            }
        }
    }

    private static let inbox = TaskBoardLane(
        axis: .project, value: nil, title: SharedConstants.taskBoardInboxLabel)

    private static var tradeOptions: [LabeledOption] {
        EntityCatalog[.task].field("trade")?.controlOptions ?? []
    }

    private static func tradeLabel(_ value: String) -> String? {
        tradeOptions.first { $0.value == value }?.label
    }
}
