import ActivityKit
import Foundation

nonisolated struct DeviceWorkAttributes: ActivityAttributes {
    nonisolated struct ContentState: Codable, Hashable {
        let title: String
        let detail: String
        let progress: Double?
        let estimatedRemaining: String?
        let additionalCount: Int
        let localActivityID: String
    }

    let sessionID: String
}
