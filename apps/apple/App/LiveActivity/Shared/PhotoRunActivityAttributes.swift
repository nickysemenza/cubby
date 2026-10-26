import ActivityKit
import Foundation

nonisolated struct PhotoRunActivityAttributes: ActivityAttributes {
    nonisolated struct ContentState: Codable, Hashable {
        let phase: String
        let title: String
        let detail: String
        let completed: Int
        let total: Int
        let needsAttention: Bool

        var shouldEnd: Bool {
            ["ready_for_review", "ready_for_handoff", "completed", "failed", "cancelled"].contains(phase)
                || needsAttention
        }

        var symbol: String {
            if needsAttention || phase == "failed" { return "exclamationmark.circle" }
            if phase == "cancelled" { return "xmark.circle" }
            if shouldEnd { return "checkmark.circle" }
            return "photo.stack"
        }

        /// Ending removes the Dynamic Island immediately; keep the final result briefly on the Lock Screen.
        func dismissalDate(at now: Date) -> Date { now.addingTimeInterval(20 * 60) }
    }

    let runId: String
}
