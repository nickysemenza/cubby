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
    }

    let runId: String
}
